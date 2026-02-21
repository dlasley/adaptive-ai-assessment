/**
 * High-level pipeline step functions.
 *
 * Extracted from regenerate.ts — each step handles one stage of the
 * content generation pipeline. Used by both corpus-generate (production)
 * and experiment-generate (A/B testing) orchestrators.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { units } from '../../src/lib/units';
import { insertUnitEntry } from './file-updaters';
import {
  checkPdftotext,
  convertPdfToMarkdown,
  extractPdfText,
} from './pdf-conversion';
import { runScript, runScriptAsync, promptUser } from './script-runner';
import { findMarkdownForUnit, findPdfsForUnit, LEARNINGS_DIR } from './unit-discovery';

/**
 * Options shared across pipeline steps.
 * Orchestrators construct this from their own CLI options.
 */
export interface StepOptions {
  dryRun: boolean;
  writeDb: boolean;
  skipConvert?: boolean;
  forceConvert?: boolean;
  skipTopics?: boolean;
  reviewTopics?: boolean;
  skipResources?: boolean;
  convertOnly?: boolean;
  batchId?: string;
  markdownFile?: string;
  auditor: 'mistral' | 'sonnet';
  // Experiment pass-through (optional, only used by experiment-generate)
  experimentId?: string;
  cohort?: string;
  generationModelStructured?: string;
  generationModelTyped?: string;
  validationModel?: string;
  auditModel?: string;
}

// ─── Step 1: PDF → Markdown Conversion ───────────────────────────────────────

export async function stepConvertPdf(
  unitId: string,
  options: StepOptions,
  anthropic: Anthropic
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
        const markdown = await convertPdfToMarkdown(anthropic, pdfText, pdfName);
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

// ─── Step 2: Topic Extraction & Validation ───────────────────────────────────

export async function stepExtractTopics(
  unitId: string,
  markdownPath: string,
  options: StepOptions
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
      console.log('  ⏹️  Stopped by user');
      return { success: false };
    }
  }

  const updatedUnit = units.find(u => u.id === unitId);
  return { success: true, topics: updatedUnit?.topics.map(t => t.name) || [] };
}

// ─── Step 2.5: Auto-update Source Files ──────────────────────────────────────

export async function stepAutoUpdateFiles(
  unitId: string,
  options: StepOptions
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

// ─── Step 3: Question Generation ─────────────────────────────────────────────

export async function stepGenerateQuestions(
  unitId: string,
  topics: string[],
  options: StepOptions
): Promise<{ success: boolean; count?: number }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 3: Question Generation                               │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  console.log(`  📚 Generating questions for ${topics.length} topics`);
  console.log(`  🎯 Unit: ${unitId}`);

  const args = ['--unit', unitId];
  if (options.writeDb) {
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

  return runScriptAsync('scripts/generate-questions.ts', args);
}

// ─── Step 4: Quality Audit ───────────────────────────────────────────────────

export async function stepAuditQuestions(
  unitId: string,
  options: StepOptions
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

  return runScriptAsync(`scripts/${auditScript}`, args);
}

// ─── Step 5: Learning Resource Extraction ────────────────────────────────────

export async function stepExtractResources(
  unitId: string,
  options: StepOptions
): Promise<{ success: boolean }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 5: Learning Resource Extraction                       │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const resourceArgs = ['--unit', unitId, '--write-db'];
  const result = runScript('scripts/extract-learning-resources.ts', resourceArgs, options.dryRun);
  if (!result.success) {
    console.log('\n  ⚠️  Resource extraction failed (non-fatal)');
  }
  return { success: result.success };
}
