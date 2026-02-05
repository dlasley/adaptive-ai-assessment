/**
 * Controller script for the content regeneration pipeline
 *
 * Orchestrates:
 * 1. PDF → Markdown conversion (convert-pdfs.ts logic)
 * 2. Topic extraction & validation (suggest-unit-topics.ts logic)
 * 3. Question generation (generate-questions.ts)
 *
 * Usage:
 *   npx tsx scripts/regenerate.ts <unit-id> [options]
 *   npx tsx scripts/regenerate.ts --all [options]
 *
 * Options:
 *   --review-topics Enable interactive topic review (for expert users)
 *   --skip-convert  Skip PDF conversion (use existing markdown)
 *   --skip-topics   Skip topic extraction (use existing topics in units.ts)
 *   --sync-db       Sync generated questions to Supabase
 *   --dry-run       Show what would be done without executing
 *
 * Examples:
 *   npx tsx scripts/regenerate.ts unit-4
 *   npx tsx scripts/regenerate.ts unit-4 --sync-db
 *   npx tsx scripts/regenerate.ts unit-4 --skip-convert
 *   npx tsx scripts/regenerate.ts --all --sync-db
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { units } from '../src/lib/units';

// Initialize Anthropic client for PDF conversion
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Directory paths
const PDF_DIR = path.join(process.cwd(), 'PDF');
const LEARNINGS_DIR = path.join(process.cwd(), 'learnings');

interface PipelineOptions {
  unitId: string | '--all';
  reviewTopics: boolean;
  skipConvert: boolean;
  forceConvert: boolean;
  skipTopics: boolean;
  syncDb: boolean;
  dryRun: boolean;
}

// PDF to Markdown conversion prompt (same as convert-pdfs.ts)
const CONVERSION_PROMPT = `You are converting French language course materials from PDF to clean, structured markdown.

## Output Requirements

**CRITICAL - DO NOT include these artifacts:**
- No introductory commentary like "Here's the content..." or "I'll convert this..."
- No code fence wrappers (\`\`\`markdown ... \`\`\`)
- No concluding summaries like "This markdown preserves..." or "Perfect for..."
- No meta-commentary about the conversion process
- START IMMEDIATELY with the heading: # French I - [Unit Name]

## Structure Format

Use this exact structure:

# French I - [Unit Name]

## [Section Title]
[Content]

---

## Vocabulaire actif
- **french_word** - english_translation
- **un(e) élève** - a student

### Grammar Notes
[Explanations]

### Réponses (Answers)
1. Answer one
2. Answer two

---

## [Next Section]

## Formatting Rules

1. **Section Separators**: Use \`---\` between major sections
2. **Vocabulary Lists**: Use \`- **word** - translation\` format
3. **Numbered Lists**: Preserve from source (exercises, rules, etc.)
4. **YouTube Links**: Preserve as-is when present
5. **French-English Pairs**: Format as \`**French phrase** - English translation\`
6. **Grammar Tables**: Use markdown tables when appropriate
7. **Answer Keys**: Include under \`### Réponses\` subsections
8. **Headings**: Use ## for main sections, ### for subsections

## Content Preservation

MUST preserve:
- All French vocabulary with accents (é, è, ê, ë, à, â, ù, û, ô, ç, etc.)
- All answer keys and exercise solutions
- YouTube video links
- Grammar explanations and conjugation tables
- Cultural notes and context
- Activity instructions

DO NOT add:
- Your own commentary or observations
- Suggestions for teachers
- Quality assessments of the content
- Explanations of what the markdown is "good for"

Now convert the following PDF text content to clean markdown:

`;

/**
 * Extract text from PDF using pdftotext (from poppler)
 */
function extractPdfText(pdfPath: string): string {
  try {
    const result = execSync(`pdftotext "${pdfPath}" -`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
    return result;
  } catch (error) {
    console.error(`  ❌ Error extracting text from ${path.basename(pdfPath)}:`, error);
    throw error;
  }
}

/**
 * Convert PDF text to markdown using Claude
 */
async function convertPdfToMarkdown(pdfText: string, pdfName: string): Promise<string> {
  console.log(`  📝 Sending ${pdfName} to Claude for conversion...`);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: CONVERSION_PROMPT + pdfText,
      },
    ],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

  // Clean common LLM artifacts
  return cleanConversionArtifacts(responseText);
}

/**
 * Clean common LLM artifacts from conversion output
 */
function cleanConversionArtifacts(text: string): string {
  let cleaned = text;

  // Remove opening code fence
  if (cleaned.startsWith('```markdown')) {
    cleaned = cleaned.replace(/^```markdown\n?/, '');
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\n?/, '');
  }

  // Remove closing code fence
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/\n?```$/, '');
  }

  // Remove introductory lines
  const introPatterns = [
    /^I'll convert this.*?\n+/i,
    /^Here's the.*?\n+/i,
    /^The PDF file.*?\n+/i,
    /^Perfect!.*?\n+/i,
    /^Now I'll.*?\n+/i,
  ];

  for (const pattern of introPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove concluding summaries (after last ---)
  const lastSeparator = cleaned.lastIndexOf('\n---\n');
  if (lastSeparator !== -1) {
    const afterSeparator = cleaned.substring(lastSeparator + 5);
    if (
      afterSeparator.includes('This markdown preserves') ||
      afterSeparator.includes('Perfect for') ||
      afterSeparator.includes('The content above')
    ) {
      cleaned = cleaned.substring(0, lastSeparator + 5);
    }
  }

  return cleaned.trim();
}

/**
 * Check if pdftotext is available
 */
function checkPdftotext(): boolean {
  try {
    execSync('which pdftotext', { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

interface StepResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): PipelineOptions {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const options: PipelineOptions = {
    unitId: args[0],
    reviewTopics: args.includes('--review-topics'),
    skipConvert: args.includes('--skip-convert'),
    forceConvert: args.includes('--force-convert'),
    skipTopics: args.includes('--skip-topics'),
    syncDb: args.includes('--sync-db'),
    dryRun: args.includes('--dry-run'),
  };

  return options;
}

function printUsage(): void {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              CONTENT REGENERATION PIPELINE                     ║
╚════════════════════════════════════════════════════════════════╝

Usage:
  npx tsx scripts/regenerate.ts <unit-id> [options]
  npx tsx scripts/regenerate.ts --all [options]

Options:
  --review-topics Interactive topic review (for fluent French speakers only)
  --skip-convert  Skip PDF conversion (use existing markdown)
  --force-convert Force PDF reconversion even if markdown exists
  --skip-topics   Skip topic extraction (use existing topics in units.ts)
  --sync-db       Sync generated questions to database
  --dry-run       Show what would be done without executing

Examples:
  npx tsx scripts/regenerate.ts unit-4           # Full pipeline for unit-4
  npx tsx scripts/regenerate.ts unit-4 --sync-db # Generate and sync to DB
  npx tsx scripts/regenerate.ts unit-4 --skip-convert --sync-db
  npx tsx scripts/regenerate.ts --all --sync-db  # Regenerate all units

Pipeline Steps:
  1. PDF → Markdown    Convert PDF to structured markdown
  2. Topic Extraction  Extract and validate topics against units.ts
  3. Question Gen      Generate questions for each topic/difficulty
  `);
}

/**
 * Prompt user for confirmation
 */
async function promptUser(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Find all PDF files for a unit
 * Returns all PDFs matching the unit pattern (canonical first, then others)
 */
function findPdfsForUnit(unitId: string): string[] {
  const matches: string[] = [];

  if (!fs.existsSync(PDF_DIR)) {
    return matches;
  }

  const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  // Special case for 'introduction' unit
  if (unitId === 'introduction') {
    const pattern = /introduction/i;
    for (const file of files) {
      if (pattern.test(file)) {
        matches.push(path.join(PDF_DIR, file));
      }
    }
    // Sort with "French 1 Introduction.pdf" first
    matches.sort((a, b) => {
      const aIsCanonical = path.basename(a).toLowerCase() === 'french 1 introduction.pdf';
      const bIsCanonical = path.basename(b).toLowerCase() === 'french 1 introduction.pdf';
      if (aIsCanonical && !bIsCanonical) return -1;
      if (!aIsCanonical && bIsCanonical) return 1;
      return a.localeCompare(b);
    });
    return matches;
  }

  // Standard unit-N pattern handling
  const unitNum = unitId.replace('unit-', '');

  // Pattern requires unit number to be followed by non-digit (or end of string)
  // to avoid "unit 20" matching "unit 2"
  const pattern = new RegExp(`unit[\\s_-]?${unitNum}(?:\\D|$)`, 'i');

  // Sort: canonical first (French 1 Unit X.pdf), then others alphabetically
  const canonical = `French 1 Unit ${unitNum}.pdf`;

  for (const file of files) {
    if (pattern.test(file)) {
      matches.push(path.join(PDF_DIR, file));
    }
  }

  // Sort with canonical first
  matches.sort((a, b) => {
    const aIsCanonical = path.basename(a) === canonical;
    const bIsCanonical = path.basename(b) === canonical;
    if (aIsCanonical && !bIsCanonical) return -1;
    if (!aIsCanonical && bIsCanonical) return 1;
    return a.localeCompare(b);
  });

  return matches;
}

/**
 * Find markdown file for a unit
 * Searches for files containing "unit X" or "unit-X" (case-insensitive)
 * Throws on ambiguous matches, returns null if nothing found
 */
function findMarkdownForUnit(unitId: string): string | null {
  // Special case for 'introduction' unit
  if (unitId === 'introduction') {
    const explicitPaths = [
      path.join(LEARNINGS_DIR, 'French 1 Introduction.md'),
      path.join(LEARNINGS_DIR, 'introduction.md'),
    ];

    for (const p of explicitPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Search for any .md file containing "introduction" in the filename
    const pattern = /introduction/i;
    const searchDirs = [LEARNINGS_DIR, path.join(LEARNINGS_DIR, 'test-conversions')];
    const matches: string[] = [];

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        if (pattern.test(file)) {
          matches.push(path.join(dir, file));
        }
      }
    }

    if (matches.length === 1) {
      console.log(`  Found markdown via pattern match: ${matches[0]}`);
      return matches[0];
    }
    if (matches.length > 1) {
      console.error(`  Ambiguous: found ${matches.length} markdown files matching "introduction":`);
      for (const m of matches) {
        console.error(`     - ${m}`);
      }
      throw new Error('Ambiguous markdown files for introduction');
    }
    return null;
  }

  // Standard unit-N handling
  const unitNum = unitId.replace('unit-', '');

  // Priority 1: Check explicit paths first (no ambiguity possible)
  const explicitPaths = [
    path.join(LEARNINGS_DIR, `French 1 Unit ${unitNum}.md`),
    path.join(LEARNINGS_DIR, `unit-${unitNum}.md`),
    path.join(LEARNINGS_DIR, 'test-conversions', `unit-${unitNum}-test.md`),
  ];

  for (const p of explicitPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Priority 2: Search for any .md file containing "unit X" or "unit-X" in the filename
  // Pattern requires unit number to be followed by non-digit (or end of string)
  // to avoid "unit 20" matching "unit 2"
  const pattern = new RegExp(`unit[\\s_-]?${unitNum}(?:\\D|$)`, 'i');

  const searchDirs = [LEARNINGS_DIR, path.join(LEARNINGS_DIR, 'test-conversions')];
  const matches: string[] = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      if (pattern.test(file)) {
        matches.push(path.join(dir, file));
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    console.log(`  📄 Found markdown via pattern match: ${matches[0]}`);
    return matches[0];
  }

  // Multiple matches - ambiguous, report error
  console.error(`  ❌ Ambiguous: found ${matches.length} markdown files matching "${unitId}":`);
  for (const m of matches) {
    console.error(`     - ${m}`);
  }
  console.error(`  💡 Rename files or use explicit path with suggest-unit-topics.ts directly`);
  throw new Error(`Ambiguous markdown files for ${unitId}`);
}

/**
 * Run a script and capture output
 */
function runScript(command: string, args: string[], dryRun: boolean): StepResult {
  const fullCommand = `npx tsx ${command} ${args.join(' ')}`;

  if (dryRun) {
    console.log(`  [DRY RUN] Would execute: ${fullCommand}`);
    return { success: true, output: '[dry run - not executed]' };
  }

  try {
    const output = execSync(fullCommand, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || error.stderr,
    };
  }
}

/**
 * Step 1: Convert PDFs to Markdown
 * Finds all PDFs for a unit and combines their markdown into one file
 * Auto-converts PDFs if markdown doesn't exist
 */
async function stepConvertPdf(
  unitId: string,
  options: PipelineOptions
): Promise<{ success: boolean; markdownPath?: string }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 1: PDF → Markdown Conversion                         │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // Skip conversion entirely if requested
  if (options.skipConvert) {
    console.log('  ⏭️  Skipping (--skip-convert)');
    const existingMd = findMarkdownForUnit(unitId);
    if (existingMd) {
      console.log(`  ℹ️  Using existing: ${existingMd}`);
      return { success: true, markdownPath: existingMd };
    }
    console.log('  ❌ No existing markdown found');
    return { success: false };
  }

  const pdfPaths = findPdfsForUnit(unitId);

  // No PDFs found - fall back to existing markdown
  if (pdfPaths.length === 0) {
    console.log(`  ⚠️  No PDFs found for ${unitId}`);
    const existingMd = findMarkdownForUnit(unitId);
    if (existingMd) {
      console.log(`  ℹ️  Using existing markdown: ${existingMd}`);
      return { success: true, markdownPath: existingMd };
    }
    return { success: false };
  }

  console.log(`  📄 Found ${pdfPaths.length} PDF(s) for ${unitId}:`);
  for (const p of pdfPaths) {
    console.log(`     - ${path.basename(p)}`);
  }

  // Combined output path
  const combinedOutput = unitId === 'introduction'
    ? path.join(LEARNINGS_DIR, 'French 1 Introduction.md')
    : path.join(LEARNINGS_DIR, `French 1 Unit ${unitId.replace('unit-', '')}.md`);

  // Dry run - just report what would happen
  if (options.dryRun) {
    console.log(`  [DRY RUN] Would convert ${pdfPaths.length} PDF(s) and combine to: ${combinedOutput}`);
    return { success: true, markdownPath: combinedOutput };
  }

  // Check if combined output already exists (skip if --force-convert)
  if (fs.existsSync(combinedOutput) && !options.forceConvert) {
    console.log(`  ✅ Using existing combined markdown: ${combinedOutput}`);
    return { success: true, markdownPath: combinedOutput };
  }

  if (options.forceConvert && fs.existsSync(combinedOutput)) {
    console.log(`  🔄 Force reconverting (--force-convert)`);
  }

  // Ensure learnings directory exists
  if (!fs.existsSync(LEARNINGS_DIR)) {
    fs.mkdirSync(LEARNINGS_DIR, { recursive: true });
  }

  // Check for pdftotext
  if (!checkPdftotext()) {
    console.error('  ❌ pdftotext not found. Install poppler: brew install poppler');
    return { success: false };
  }

  // Look for existing individual conversions first (unless force-convert)
  const markdownContents: string[] = [];
  const needsConversion: string[] = [];

  if (!options.forceConvert) {
    console.log('  📝 Looking for existing conversions...');
    for (const pdfPath of pdfPaths) {
      const baseName = path.basename(pdfPath, '.pdf');
      const possibleMds = [
        path.join(LEARNINGS_DIR, `${baseName}.md`),
        path.join(LEARNINGS_DIR, 'test-conversions', `${baseName}.md`),
      ];

      let found = false;
      for (const mdPath of possibleMds) {
        if (fs.existsSync(mdPath)) {
          console.log(`     ✓ Found existing: ${path.basename(mdPath)}`);
          const content = fs.readFileSync(mdPath, 'utf-8');
          markdownContents.push(`# Source: ${path.basename(pdfPath)}\n\n${content}`);
          found = true;
          break;
        }
      }

      if (!found) {
        needsConversion.push(pdfPath);
      }
    }
  } else {
    // Force convert all
    needsConversion.push(...pdfPaths);
  }

  // Convert any PDFs that need conversion
  if (needsConversion.length > 0) {
    console.log(`\n  🔄 Converting ${needsConversion.length} PDF(s) to markdown...`);
    console.log('     (Using Claude Sonnet for conversion)\n');

    for (const pdfPath of needsConversion) {
      const pdfName = path.basename(pdfPath);
      try {
        // Extract text from PDF
        console.log(`  📑 Extracting text from ${pdfName}...`);
        const pdfText = extractPdfText(pdfPath);
        console.log(`     Extracted ${pdfText.length.toLocaleString()} characters`);

        // Convert to markdown via Claude
        const markdown = await convertPdfToMarkdown(pdfText, pdfName);
        console.log(`     Converted to ${markdown.length.toLocaleString()} characters of markdown`);

        markdownContents.push(`# Source: ${pdfName}\n\n${markdown}`);

        // Small delay between API calls
        if (needsConversion.indexOf(pdfPath) < needsConversion.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (error: any) {
        console.error(`  ❌ Failed to convert ${pdfName}: ${error.message}`);
        return { success: false };
      }
    }
  }

  if (markdownContents.length === 0) {
    console.log('  ❌ No markdown content generated');
    return { success: false };
  }

  // Combine and save
  if (markdownContents.length > 1) {
    console.log(`\n  📎 Combining ${markdownContents.length} markdown sources...`);
    const combined = markdownContents.join('\n\n---\n\n');
    fs.writeFileSync(combinedOutput, combined);
    console.log(`  ✅ Created combined markdown: ${combinedOutput}`);
  } else {
    // Single source - write directly to combined output
    fs.writeFileSync(combinedOutput, markdownContents[0]);
    console.log(`  ✅ Created markdown: ${combinedOutput}`);
  }

  return { success: true, markdownPath: combinedOutput };
}

/**
 * Step 2: Extract and validate topics
 */
async function stepExtractTopics(
  unitId: string,
  markdownPath: string,
  options: PipelineOptions
): Promise<{ success: boolean; topics?: string[] }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 2: Topic Extraction & Validation                     │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const existingUnit = units.find(u => u.id === unitId);

  if (options.skipTopics) {
    console.log('  ⏭️  Skipping (--skip-topics)');
    if (existingUnit) {
      console.log(`  ℹ️  Using ${existingUnit.topics.length} existing topics from units.ts`);
      return { success: true, topics: existingUnit.topics };
    }
    console.log(`  ❌ Unit ${unitId} not found in units.ts`);
    return { success: false };
  }

  if (existingUnit && !options.reviewTopics) {
    console.log(`  ℹ️  Using ${existingUnit.topics.length} existing topics`);
    existingUnit.topics.forEach(t => console.log(`     • ${t}`));
    return { success: true, topics: existingUnit.topics };
  }

  // Run topic extraction
  console.log(`  🔍 Extracting topics from: ${path.basename(markdownPath)}`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would run: npx tsx scripts/suggest-unit-topics.ts "${markdownPath}" ${unitId}`);
    return { success: true, topics: existingUnit?.topics || [] };
  }

  const result = runScript('scripts/suggest-unit-topics.ts', [
    `"${markdownPath}"`,
    unitId,
  ], false);

  if (!result.success) {
    console.log(`  ❌ Topic extraction failed: ${result.error}`);
    return { success: false };
  }

  console.log(result.output);

  // After topic extraction, prompt for review if --review-topics specified
  if (options.reviewTopics) {
    console.log('\n  ⚠️  Review the suggested topics above');
    console.log('     Update units.ts if needed, then continue');

    const proceed = await promptUser('\n  Continue with question generation?');
    if (!proceed) {
      console.log('  ⏸️  Paused for manual topic review');
      console.log('     Run again with --skip-topics after updating units.ts');
      return { success: false };
    }
  }

  // Re-read units.ts to get updated topics
  // Note: This won't work at runtime since units.ts is already imported
  // User should re-run the script after updating units.ts
  const updatedUnit = units.find(u => u.id === unitId);
  return { success: true, topics: updatedUnit?.topics || [] };
}

/**
 * Step 3: Generate questions
 */
async function stepGenerateQuestions(
  unitId: string,
  topics: string[],
  options: PipelineOptions
): Promise<{ success: boolean; count?: number }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 3: Question Generation                               │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log(`  📚 Generating questions for ${topics.length} topics`);
  console.log(`  🎯 Unit: ${unitId}`);

  const args = ['--unit', unitId];
  if (options.syncDb) {
    args.push('--sync-db');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }

  console.log(`  🚀 Running: npx tsx scripts/generate-questions.ts ${args.join(' ')}\n`);

  if (options.dryRun) {
    const estimate = topics.length * 3 * 10;
    console.log(`  [DRY RUN] Would generate ~${estimate} questions`);
    return { success: true, count: estimate };
  }

  // Use spawn to stream output in real-time
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', 'scripts/generate-questions.ts', ...args], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false });
      }
    });

    proc.on('error', (err) => {
      console.error(`  ❌ Error: ${err.message}`);
      resolve({ success: false });
    });
  });
}

/**
 * Run the pipeline for a single unit
 */
async function runPipelineForUnit(
  unitId: string,
  options: PipelineOptions
): Promise<void> {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  PROCESSING: ${unitId.toUpperCase()}`);
  console.log(`${'═'.repeat(65)}`);

  // Step 1: Convert PDF
  const step1 = await stepConvertPdf(unitId, options);
  if (!step1.success || !step1.markdownPath) {
    console.log('\n  ❌ Pipeline stopped: No markdown available');
    return;
  }

  // Step 2: Extract topics
  const step2 = await stepExtractTopics(unitId, step1.markdownPath, options);
  if (!step2.success) {
    console.log('\n  ❌ Pipeline stopped at topic extraction');
    return;
  }

  // Step 3: Generate questions
  const step3 = await stepGenerateQuestions(unitId, step2.topics || [], options);
  if (!step3.success) {
    console.log('\n  ❌ Question generation failed');
    return;
  }

  console.log('\n  ✅ Pipeline complete for', unitId);
}

/**
 * Main function
 */
async function main() {
  const options = parseArgs();

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              CONTENT REGENERATION PIPELINE                     ║
╚════════════════════════════════════════════════════════════════╝
`);

  console.log('Configuration:');
  console.log(`  Unit(s):       ${options.unitId}`);
  console.log(`  Review topics: ${options.reviewTopics ? 'Yes (interactive)' : 'No (auto)'}`);
  console.log(`  Skip convert:  ${options.skipConvert ? 'Yes' : 'No'}`);
  console.log(`  Force convert: ${options.forceConvert ? 'Yes' : 'No'}`);
  console.log(`  Skip topics:   ${options.skipTopics ? 'Yes' : 'No'}`);
  console.log(`  Sync to DB:    ${options.syncDb ? 'Yes' : 'No'}`);
  console.log(`  Dry run:       ${options.dryRun ? 'Yes' : 'No'}`);

  if (options.unitId === '--all') {
    // Process all units
    for (const unit of units) {
      await runPipelineForUnit(unit.id, options);
    }
  } else {
    // Validate unit exists or is a valid new unit
    const existingUnit = units.find(u => u.id === options.unitId);
    if (!existingUnit && !options.unitId.match(/^unit-\d+$/)) {
      console.error(`\n❌ Invalid unit ID: ${options.unitId}`);
      console.log('   Format: unit-N (e.g., unit-4)');
      console.log('   Existing units:', units.map(u => u.id).join(', '));
      process.exit(1);
    }

    await runPipelineForUnit(options.unitId, options);
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log('  PIPELINE COMPLETE');
  console.log(`${'═'.repeat(65)}\n`);
}

// Run
main().catch(console.error);
