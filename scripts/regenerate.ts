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
 *   --write-db      Sync generated questions to Supabase
 *   --audit         Run quality audit after generation (requires --write-db)
 *   --auditor <m>   Audit model: 'mistral' (default) or 'sonnet'
 *   --dry-run       Show what would be done without executing
 *
 * Examples:
 *   npx tsx scripts/regenerate.ts unit-4
 *   npx tsx scripts/regenerate.ts unit-4 --write-db
 *   npx tsx scripts/regenerate.ts unit-4 --write-db --audit
 *   npx tsx scripts/regenerate.ts unit-4 --skip-convert
 *   npx tsx scripts/regenerate.ts --all --write-db
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { units } from '../src/lib/units';
import { insertUnitEntry } from './lib/file-updaters';
import { MODELS } from './lib/config';

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
  audit: boolean;
  auditor: 'mistral' | 'sonnet';
  dryRun: boolean;
  convertOnly: boolean;
  batchId?: string;
  markdownFile?: string;
  // Experiment framework
  experimentId?: string;
  cohort?: string;
  generationModelStructured?: string;
  generationModelTyped?: string;
  validationModel?: string;
  auditModel?: string;
}

// Load PDF-to-Markdown conversion prompt from file (single source of truth)
const CONVERSION_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'prompts', 'pdf-to-markdown.txt'),
  'utf-8'
) + '\n\nNow convert the following PDF text content to clean markdown:\n\n';

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
 * Split pdftotext output into chunks using form feed page boundaries.
 * Groups pages so each chunk stays under maxCharsPerChunk.
 */
function chunkPdfText(pdfText: string, maxCharsPerChunk: number = 15000): string[] {
  // pdftotext inserts form feed (\f) between pages
  const pages = pdfText.split('\f').filter(p => p.trim().length > 0);

  if (pages.length === 0) return [pdfText];

  const chunks: string[] = [];
  let currentChunk = '';

  for (const page of pages) {
    if (currentChunk.length + page.length > maxCharsPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += page + '\n\n';
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Convert a single chunk of PDF text to markdown using Claude
 */
async function convertChunkToMarkdown(
  chunkText: string,
  pdfName: string,
  chunkIndex: number,
  totalChunks: number
): Promise<string> {
  const chunkContext = totalChunks > 1
    ? `\n\nNote: This is section ${chunkIndex + 1} of ${totalChunks} from ${pdfName}. Convert ALL content faithfully — do NOT summarize, skip exercises, or deduplicate. If a section continues from a previous chunk, just convert what you see.\n\n`
    : '\n\n';

  const message = await anthropic.messages.create({
    model: MODELS.pdfConversion,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: CONVERSION_PROMPT + chunkContext + chunkText,
      },
    ],
  });

  const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
  return cleanConversionArtifacts(responseText);
}

/**
 * Convert PDF text to markdown using Claude, chunking large inputs
 */
async function convertPdfToMarkdown(pdfText: string, pdfName: string): Promise<string> {
  const chunks = chunkPdfText(pdfText);

  if (chunks.length === 1) {
    console.log(`  📝 Sending ${pdfName} to Claude for conversion (1 chunk)...`);
    return convertChunkToMarkdown(chunks[0], pdfName, 0, 1);
  }

  console.log(`  📝 Sending ${pdfName} to Claude in ${chunks.length} chunks...`);
  const markdownParts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`     Chunk ${i + 1}/${chunks.length} (${chunks[i].length.toLocaleString()} chars)...`);
    const md = await convertChunkToMarkdown(chunks[i], pdfName, i, chunks.length);
    markdownParts.push(md);

    // Rate limit delay between chunks
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return markdownParts.join('\n\n---\n\n');
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

  const hasWriteDb = args.includes('--write-db');

  // Parse --auditor flag (default: mistral)
  const auditorIdx = args.indexOf('--auditor');
  const auditorValue = auditorIdx >= 0 ? args[auditorIdx + 1] : 'mistral';
  if (!['mistral', 'sonnet'].includes(auditorValue)) {
    console.error(`❌ Invalid --auditor value: ${auditorValue}. Must be 'mistral' or 'sonnet'.`);
    process.exit(1);
  }

  // Parse --batch-id flag
  const batchIdIdx = args.indexOf('--batch-id');
  const batchIdValue = batchIdIdx >= 0 ? args[batchIdIdx + 1] : undefined;

  // Parse --markdown-file flag
  const mdFileIdx = args.indexOf('--markdown-file');
  const mdFileValue = mdFileIdx >= 0 ? args[mdFileIdx + 1] : undefined;

  // Parse experiment flags
  const expIdIdx = args.indexOf('--experiment-id');
  const expIdValue = expIdIdx >= 0 ? args[expIdIdx + 1] : undefined;
  const cohortIdx = args.indexOf('--cohort');
  const cohortValue = cohortIdx >= 0 ? args[cohortIdx + 1] : undefined;
  const genStructIdx = args.indexOf('--generation-model-structured');
  const genStructValue = genStructIdx >= 0 ? args[genStructIdx + 1] : undefined;
  const genTypedIdx = args.indexOf('--generation-model-typed');
  const genTypedValue = genTypedIdx >= 0 ? args[genTypedIdx + 1] : undefined;
  const valModelIdx = args.indexOf('--validation-model');
  const valModelValue = valModelIdx >= 0 ? args[valModelIdx + 1] : undefined;
  const auditModelIdx = args.indexOf('--audit-model');
  const auditModelValue = auditModelIdx >= 0 ? args[auditModelIdx + 1] : undefined;

  const options: PipelineOptions = {
    unitId: args[0],
    reviewTopics: args.includes('--review-topics'),
    skipConvert: args.includes('--skip-convert'),
    forceConvert: args.includes('--force-convert'),
    skipTopics: args.includes('--skip-topics'),
    syncDb: hasWriteDb,
    audit: args.includes('--audit'),
    auditor: auditorValue as 'mistral' | 'sonnet',
    dryRun: args.includes('--dry-run'),
    convertOnly: args.includes('--convert-only'),
    batchId: batchIdValue,
    markdownFile: mdFileValue,
    experimentId: expIdValue,
    cohort: cohortValue,
    generationModelStructured: genStructValue,
    generationModelTyped: genTypedValue,
    validationModel: valModelValue,
    auditModel: auditModelValue,
  };

  // Validate --audit requires --write-db
  if (options.audit && !options.syncDb) {
    console.error('❌ --audit requires --write-db (questions must be in DB to audit)');
    process.exit(1);
  }

  // Validate experiment flags
  if (options.experimentId && !options.cohort) {
    console.error('❌ --experiment-id requires --cohort');
    process.exit(1);
  }

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
  --write-db      Sync generated questions to database
  --audit         Run quality audit after generation (requires --write-db)
  --auditor <m>   Audit model: 'mistral' (default) or 'sonnet'
  --dry-run       Show what would be done without executing
  --convert-only  Stop after PDF conversion (skip topics, generation, audit)
  --batch-id <id>         Custom batch ID for experiment tracking
  --markdown-file <path>  Use specified markdown file (bypasses PDF conversion)

Examples:
  npx tsx scripts/regenerate.ts unit-4                    # Full pipeline for unit-4
  npx tsx scripts/regenerate.ts unit-4 --write-db         # Generate and sync to DB
  npx tsx scripts/regenerate.ts unit-4 --write-db --audit # Generate, sync, and audit
  npx tsx scripts/regenerate.ts unit-4 --skip-convert --write-db
  npx tsx scripts/regenerate.ts --all --write-db          # Regenerate all units

Pipeline Steps:
  1. PDF → Markdown    Convert PDF to structured markdown
  2. Topic Extraction  Extract and validate topics against units.ts
  3. Question Gen      Generate questions for each topic/difficulty
  4. Quality Audit     (optional, --audit) Promote pending → active/flagged
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

  // Use explicit markdown file if specified (bypasses all conversion/discovery)
  if (options.markdownFile) {
    const resolvedPath = path.resolve(options.markdownFile);
    if (!fs.existsSync(resolvedPath)) {
      console.log(`  ❌ Markdown file not found: ${resolvedPath}`);
      return { success: false };
    }
    console.log(`  ⏭️  Using specified markdown: ${resolvedPath}`);
    return { success: true, markdownPath: resolvedPath };
  }

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
      const topicNames = existingUnit.topics.map(t => t.name);
      console.log(`  ℹ️  Using ${topicNames.length} existing topics from units.ts`);
      return { success: true, topics: topicNames };
    }
    console.log(`  ❌ Unit ${unitId} not found in units.ts`);
    return { success: false };
  }

  if (existingUnit && !options.reviewTopics) {
    const topicNames = existingUnit.topics.map(t => t.name);
    console.log(`  ℹ️  Using ${topicNames.length} existing topics`);
    topicNames.forEach(t => console.log(`     • ${t}`));
    return { success: true, topics: topicNames };
  }

  // Run topic extraction
  console.log(`  🔍 Extracting topics from: ${path.basename(markdownPath)}`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would run: npx tsx scripts/suggest-unit-topics.ts "${markdownPath}" ${unitId}`);
    return { success: true, topics: existingUnit?.topics.map(t => t.name) || [] };
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
  return { success: true, topics: updatedUnit?.topics.map(t => t.name) || [] };
}

/**
 * Step 2.5: Auto-update units.ts for new units
 * Only runs when the unit doesn't already exist in units.ts.
 */
async function stepAutoUpdateFiles(
  unitId: string,
  options: PipelineOptions
): Promise<{ success: boolean; topics?: string[] }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 2.5: Auto-update Source Files (new unit)             │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // Read the topic extraction output
  const topicsJsonPath = path.join(process.cwd(), 'data', `topics-${unitId}.json`);
  if (!fs.existsSync(topicsJsonPath)) {
    if (options.dryRun) {
      console.log(`  [DRY RUN] Would read ${topicsJsonPath} and auto-update:`);
      console.log('     - src/lib/units.ts (new unit entry with topic headings)');
      return { success: true, topics: [] };
    }
    console.log(`  ❌ Topic extraction output not found: ${topicsJsonPath}`);
    return { success: false };
  }

  const topicsData = JSON.parse(fs.readFileSync(topicsJsonPath, 'utf-8'));

  // Log any items that need review
  if (topicsData.reconciled?.needsReview?.length > 0) {
    console.log('  ⚠️  Topics that may need manual review:');
    for (const item of topicsData.reconciled.needsReview) {
      console.log(`     ? "${item.extracted}" — ${item.reason}`);
    }
    console.log('     (Included in unit entry — edit units.ts after if needed)\n');
  }

  const suggestedTopics: string[] = topicsData.suggestedTopics || [];
  const suggestedLabel: string = topicsData.suggestedLabel || 'TODO: Add label';
  const headingMappings: Record<string, string[]> = topicsData.headingMappings || {};

  if (suggestedTopics.length === 0) {
    console.log('  ❌ No topics found in extraction output');
    return { success: false };
  }

  console.log(`  📋 ${suggestedTopics.length} topics to add`);
  console.log(`  🏷️  Label: "${suggestedLabel}"`);

  // Build topics with headings merged in
  const topicsWithHeadings = suggestedTopics.map(name => ({
    name,
    headings: headingMappings[name] || [],
  }));

  // --- Update units.ts ---
  const unitsPath = path.join(process.cwd(), 'src', 'lib', 'units.ts');
  const unitsContent = fs.readFileSync(unitsPath, 'utf-8');

  const unitNum = unitId.replace('unit-', '');
  const unitData = {
    id: unitId,
    title: `🇫🇷 Unit ${unitNum}`,
    label: suggestedLabel,
    description: `Unit ${unitNum} content`,
    topics: topicsWithHeadings,
  };

  const updatedUnits = insertUnitEntry(unitsContent, unitData);

  if (updatedUnits) {
    if (options.dryRun) {
      console.log(`\n  [DRY RUN] Would update src/lib/units.ts with ${suggestedTopics.length} topics`);
    } else {
      fs.writeFileSync(unitsPath, updatedUnits);
      console.log(`  ✅ Updated src/lib/units.ts — added ${unitId}`);
    }
  } else {
    console.log(`  ℹ️  Unit ${unitId} already in units.ts (skipped)`);
  }

  // Clean up temp JSON
  if (!options.dryRun) {
    fs.unlinkSync(topicsJsonPath);
    console.log(`  🧹 Cleaned up ${topicsJsonPath}`);
  }

  return { success: true, topics: suggestedTopics };
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
    args.push('--write-db');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }
  if (options.batchId) {
    args.push('--batch-id', options.batchId);
  }
  if (options.markdownFile) {
    args.push('--source-file', options.markdownFile);
  }
  // Pass through experiment flags
  if (options.experimentId) {
    args.push('--experiment-id', options.experimentId);
  }
  if (options.cohort) {
    args.push('--cohort', options.cohort);
  }
  if (options.generationModelStructured) {
    args.push('--generation-model-structured', options.generationModelStructured);
  }
  if (options.generationModelTyped) {
    args.push('--generation-model-typed', options.generationModelTyped);
  }
  if (options.validationModel) {
    args.push('--validation-model', options.validationModel);
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
 * Step 4: Quality audit (optional, --audit flag)
 * Audits pending questions and promotes them to active/flagged.
 * Default: Mistral (independent cross-provider audit). Override with --auditor sonnet.
 */
async function stepAuditQuestions(
  unitId: string,
  options: PipelineOptions
): Promise<{ success: boolean }> {
  const auditorLabel = options.auditor === 'mistral' ? 'Mistral Large' : 'Sonnet';
  const auditScript = options.auditor === 'mistral' ? 'audit-quality-mistral.ts' : 'audit-quality.ts';

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  STEP 4: Quality Audit — ${auditorLabel} (pending → active/flagged)  │`);
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const args = ['--write-db', '--pending-only', '--unit', unitId];
  if (options.batchId) {
    args.push('--batch', options.batchId);
  }
  // Pass through experiment flags
  if (options.experimentId) {
    args.push('--experiment-id', options.experimentId);
  }
  if (options.cohort) {
    args.push('--cohort', options.cohort);
  }
  if (options.auditModel) {
    args.push('--audit-model', options.auditModel);
  }
  console.log(`  🔍 Auditing pending questions for ${unitId} (${auditorLabel})`);
  console.log(`  🚀 Running: npx tsx scripts/${auditScript} ${args.join(' ')}\n`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would audit pending questions with ${auditorLabel} and promote to active/flagged`);
    return { success: true };
  }

  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', `scripts/${auditScript}`, ...args], {
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
      console.error(`  ❌ Audit error: ${err.message}`);
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

  // --convert-only: stop after PDF conversion
  if (options.convertOnly) {
    console.log('\n  ✅ Conversion complete (--convert-only)');
    return;
  }

  // Step 2: Extract topics
  const step2 = await stepExtractTopics(unitId, step1.markdownPath, options);
  if (!step2.success) {
    console.log('\n  ❌ Pipeline stopped at topic extraction');
    return;
  }

  // Step 2.5: Auto-update source files (only for new units)
  let topics = step2.topics || [];
  const existingUnit = units.find(u => u.id === unitId);
  if (!existingUnit) {
    const step2_5 = await stepAutoUpdateFiles(unitId, options);
    if (!step2_5.success) {
      console.log('\n  ❌ Pipeline stopped at source file update');
      return;
    }
    topics = step2_5.topics || topics;
  }

  // Step 3: Generate questions
  const step3 = await stepGenerateQuestions(unitId, topics, options);
  if (!step3.success) {
    console.log('\n  ❌ Question generation failed');
    return;
  }

  // Step 4: Quality audit (optional)
  if (options.audit) {
    const step4 = await stepAuditQuestions(unitId, options);
    if (!step4.success) {
      console.log('\n  ⚠️  Quality audit failed (questions remain as pending)');
    }
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
  console.log(`  Write to DB:   ${options.syncDb ? 'Yes' : 'No'}`);
  console.log(`  Audit:         ${options.audit ? `Yes — ${options.auditor === 'mistral' ? 'Mistral Large' : 'Sonnet'} (pending → active/flagged)` : 'No'}`);
  console.log(`  Dry run:       ${options.dryRun ? 'Yes' : 'No'}`);
  if (options.convertOnly) {
    console.log(`  Convert only:  Yes (stop after PDF conversion)`);
  }
  if (options.batchId) {
    console.log(`  Batch ID:      ${options.batchId}`);
  }
  if (options.markdownFile) {
    console.log(`  Markdown file: ${options.markdownFile}`);
  }

  if (options.unitId === '--all') {
    // Process all units
    for (const unit of units) {
      await runPipelineForUnit(unit.id, options);
    }

    // Post-processing: cross-unit topic consolidation
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  POST: Cross-Unit Topic Consolidation                      │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    const consolidationResult = runScript('scripts/suggest-unit-topics.ts', ['--consolidate'], options.dryRun);
    if (consolidationResult.output) {
      console.log(consolidationResult.output);
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
