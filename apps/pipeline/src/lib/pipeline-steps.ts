/**
 * High-level pipeline step functions.
 *
 * Each step handles one stage of the content generation pipeline. Used by the
 * pipeline-run orchestrator.
 */

import fs from 'fs';
import path from 'path';
import type { Unit } from '@adaptive/shared/types';
import { createScriptSupabase } from './db-queries';
import { checkPdfTools, convertPdfToMarkdown } from './pdf-conversion';
import { runScript, runScriptAsync, promptUser } from './script-runner';
import {
  findMarkdownForUnit,
  findPdfsForUnit,
  getUnitLabel,
  resolveUnitMarkdownPath,
  resolveUnitPdfPath,
  MARKDOWN_DIR,
} from './unit-discovery';
import { createLogger } from './logger';
import { EXPORTS_DIR } from './paths';
import { sleep } from './sleep';
import { estimateUnitQuestionCount } from './pipeline-config';

const logger = createLogger('pipeline-steps');

/**
 * Options shared across pipeline steps.
 * Orchestrators construct this from their own CLI options.
 */
export interface StepOptions {
  dryRun: boolean;
  writeDb: boolean;
  /** `--yes-production` was passed to the orchestrator; each writing child needs it in its own argv. */
  yesProduction?: boolean;
  skipConvert?: boolean;
  forceConvert?: boolean;
  skipTopics?: boolean;
  reviewTopics?: boolean;
  skipResources?: boolean;
  convertOnly?: boolean;
  batchId?: string;
  markdownFile?: string;
  /** Model slug for a separate teaching-content classifier gating PDF conversion (see
   * slide-content-classifier.ts) — undefined runs the unchanged transcription-only path. */
  exclusionPass?: string;
  auditor: 'mistral' | 'sonnet';
  // Forwarded to every child script this orchestrator spawns, so `--verbose`/`--quiet` passed to
  // the top-level command apply to the whole pipeline, not just the orchestrator's own output.
  verbose?: boolean;
  quiet?: boolean;
}

/** Builds the `--yes-production` arg a writing child needs to accept the confirmed write target. */
function targetArgs(options: Pick<StepOptions, 'yesProduction'>): string[] {
  return options.yesProduction ? ['--yes-production'] : [];
}

/** Builds the `--verbose`/`--quiet` args to forward to a child script, from the orchestrator's own flags. */
function loggingArgs(options: Pick<StepOptions, 'verbose' | 'quiet'>): string[] {
  const args: string[] = [];
  if (options.verbose) args.push('--verbose');
  if (options.quiet) args.push('--quiet');
  return args;
}

// ─── Step 1: PDF → Markdown Conversion ───────────────────────────────────────

/** Filename stem (no extension) of a markdown path, for recording as source_file_stem. */
function stemOf(markdownPath: string): string {
  return path.basename(markdownPath, '.md');
}

export async function stepConvertPdf(
  unitId: string,
  options: StepOptions,
  units: Unit[]
): Promise<{ success: boolean; markdownPath?: string; sourceFileStem?: string }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 1: PDF → Markdown Conversion                         │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // Use explicit markdown file if specified (bypasses all conversion/discovery).
  // Not recorded as source_file_stem — this is a one-off override, not necessarily
  // the unit's canonical source.
  if (options.markdownFile) {
    const resolvedPath = path.resolve(options.markdownFile);
    if (!fs.existsSync(resolvedPath)) {
      console.log(`  ❌ Markdown file not found: ${resolvedPath}`);
      return { success: false };
    }
    console.log(`  ⏭️  Using specified markdown: ${resolvedPath}`);
    return { success: true, markdownPath: resolvedPath };
  }

  // A unit with a recorded source file resolves directly — the flexible
  // pattern matching in findPdfsForUnit/findMarkdownForUnit only runs for a
  // unit discovery hasn't mapped to a file yet.
  const recordedStem = units.find(u => u.id === unitId)?.source_file_stem ?? undefined;

  // Skip conversion entirely if requested
  if (options.skipConvert) {
    console.log('  ⏭️  Skipping (--skip-convert)');
    const existingMd = recordedStem
      ? resolveUnitMarkdownPath({ source_file_stem: recordedStem })
      : findMarkdownForUnit(unitId);
    if (existingMd) {
      console.log(`  ℹ️  Using existing: ${existingMd}`);
      return { success: true, markdownPath: existingMd, sourceFileStem: recordedStem ?? stemOf(existingMd) };
    }
    console.log('  ❌ No existing markdown found');
    return { success: false };
  }

  const pdfPaths = recordedStem
    ? [resolveUnitPdfPath({ source_file_stem: recordedStem })].filter((p): p is string => p !== null)
    : findPdfsForUnit(unitId);

  // No PDFs found - fall back to existing markdown
  if (pdfPaths.length === 0) {
    console.log(`  ⚠️  No PDFs found for ${unitId}`);
    const existingMd = recordedStem
      ? resolveUnitMarkdownPath({ source_file_stem: recordedStem })
      : findMarkdownForUnit(unitId);
    if (existingMd) {
      console.log(`  ℹ️  Using existing markdown: ${existingMd}`);
      return { success: true, markdownPath: existingMd, sourceFileStem: recordedStem ?? stemOf(existingMd) };
    }
    return { success: false };
  }

  console.log(`  📄 Found ${pdfPaths.length} PDF(s) for ${unitId}:`);
  for (const p of pdfPaths) {
    console.log(`     - ${path.basename(p)}`);
  }

  // A single source PDF names the output markdown after itself; multiple
  // sources combined into one unit fall back to the unit's label. A unit
  // with a recorded stem always keeps it, regardless of source count.
  const stem = recordedStem ?? (pdfPaths.length === 1 ? path.basename(pdfPaths[0], '.pdf') : getUnitLabel(unitId));
  const combinedOutput = path.join(MARKDOWN_DIR, `${stem}.md`);

  // Dry run - just report what would happen
  if (options.dryRun) {
    console.log(`  [DRY RUN] Would convert ${pdfPaths.length} PDF(s) and combine to: ${combinedOutput}`);
    return { success: true, markdownPath: combinedOutput, sourceFileStem: stem };
  }

  // Check if combined output already exists (skip if --force-convert)
  if (fs.existsSync(combinedOutput) && !options.forceConvert) {
    console.log(`  ✅ Using existing combined markdown: ${combinedOutput}`);
    return { success: true, markdownPath: combinedOutput, sourceFileStem: stem };
  }

  if (options.forceConvert && fs.existsSync(combinedOutput)) {
    // Re-runs the whole conversion step, but each slide still reuses its on-disk cache entry
    // (keyed on slide image + text layer + prompt + model) when nothing about that slide changed —
    // --force-convert forces a fresh combined markdown file, not a fresh model call per slide.
    console.log(`  🔄 Force reconverting (--force-convert)`);
  }

  // Ensure markdown directory exists
  if (!fs.existsSync(MARKDOWN_DIR)) {
    fs.mkdirSync(MARKDOWN_DIR, { recursive: true });
  }

  // Check for the poppler CLI tools the conversion step shells out to
  const toolsCheck = checkPdfTools();
  if (!toolsCheck.ok) {
    logger.error(`Missing required poppler tools: ${toolsCheck.missing.join(', ')}. Install: brew install poppler`);
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
        path.join(MARKDOWN_DIR, `${baseName}.md`),
        path.join(MARKDOWN_DIR, 'test-conversions', `${baseName}.md`),
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

    const runId = options.batchId ?? `pdf-conversion-${unitId}-${Date.now()}`;
    const sessionId = `${runId}:pdf-conversion`;

    for (const pdfPath of needsConversion) {
      const pdfName = path.basename(pdfPath);
      try {
        const { markdown, report } = await convertPdfToMarkdown(
          pdfPath, pdfName, sessionId,
          options.exclusionPass && options.exclusionPass !== 'off' ? { model: options.exclusionPass } : undefined
        );
        console.log(`     Converted to ${markdown.length.toLocaleString()} characters of markdown`);

        const reportPath = path.join(MARKDOWN_DIR, `${path.basename(pdfPath, '.pdf')}.conversion-report.json`);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        if (report.flaggedSlides.length > 0 || report.imageDominatedSlides.length > 0) {
          console.log(
            `     ⚠️  ${report.flaggedSlides.length} flagged slide(s), ${report.imageDominatedSlides.length} image-dominated slide(s) — see ${path.basename(reportPath)}`
          );
        }

        markdownContents.push(`# Source: ${pdfName}\n\n${markdown}`);

        // Small delay between API calls
        if (needsConversion.indexOf(pdfPath) < needsConversion.length - 1) {
          await sleep(2000);
        }
      } catch (error: any) {
        logger.error(`Failed to convert ${pdfName}`, { message: error.message });
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

  return { success: true, markdownPath: combinedOutput, sourceFileStem: stem };
}

// ─── Step 2: Topic Extraction & Validation ───────────────────────────────────

export async function stepExtractTopics(
  unitId: string,
  markdownPath: string,
  options: StepOptions,
  units: Unit[]
): Promise<{ success: boolean; topics?: string[] }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 2: Topic Extraction & Validation                     │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const existingUnit = units.find(u => u.id === unitId);

  if (options.skipTopics) {
    console.log('  ⏭️  Skipping (--skip-topics)');
    if (existingUnit) {
      const topicNames = existingUnit.topics.map(t => t.name);
      console.log(`  ℹ️  Using ${topicNames.length} existing topics from DB`);
      return { success: true, topics: topicNames };
    }
    console.log(`  ❌ Unit ${unitId} not found in DB`);
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
    console.log(`  [DRY RUN] Would run: npx tsx apps/pipeline/src/commands/content-suggest-topics.ts "${markdownPath}" ${unitId}`);
    return { success: true, topics: existingUnit?.topics.map(t => t.name) || [] };
  }

  const result = runScript('content-suggest-topics.ts', [
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
    console.log('     Update units in DB if needed, then continue');

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
  options: StepOptions,
  units: Unit[],
  sourceFileStem?: string
): Promise<{ success: boolean; topics?: string[] }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 2.5: Auto-update DB (new unit)                       │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  // Read the topic extraction output
  const topicsJsonPath = path.join(EXPORTS_DIR, `topics-${unitId}.json`);
  if (!fs.existsSync(topicsJsonPath)) {
    if (options.dryRun) {
      console.log(`  [DRY RUN] Would read ${topicsJsonPath} and upsert to units table`);
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
    console.log('     (Included in unit entry — edit in DB after if needed)\n');
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

  const label = getUnitLabel(unitId);
  const row = {
    id: unitId,
    title: `🇫🇷 ${label}`,
    label: suggestedLabel,
    description: `${label} content`,
    topics: topicsWithHeadings,
    sort_order: units.length, // append after existing units
    source_file_stem: sourceFileStem ?? null,
  };

  if (options.dryRun) {
    console.log(`\n  [DRY RUN] Would upsert unit ${unitId} with ${suggestedTopics.length} topics to DB`);
  } else {
    const supabase = createScriptSupabase({ write: true });
    const { error } = await supabase
      .from('units')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      console.log(`  ❌ Failed to upsert unit: ${error.message}`);
      return { success: false };
    }
    console.log(`  ✅ Upserted ${unitId} to units table — ${suggestedTopics.length} topics`);
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
  options: StepOptions,
  units: Unit[]
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
  args.push(...targetArgs(options), ...loggingArgs(options));
  console.log(`  🚀 Running: npx tsx apps/pipeline/src/commands/questions-generate.ts ${args.join(' ')}\n`);

  if (options.dryRun) {
    const estimate = estimateUnitQuestionCount(unitId, topics, units);
    console.log(`  [DRY RUN] Would generate ~${estimate} questions`);
    return { success: true, count: estimate };
  }

  return runScriptAsync('questions-generate.ts', args);
}

// ─── Step 4: Quality Audit ───────────────────────────────────────────────────

export async function stepAuditQuestions(
  unitId: string,
  options: StepOptions
): Promise<{ success: boolean }> {
  const auditorLabel = options.auditor === 'mistral' ? 'Mistral Large' : 'Sonnet';
  const auditScript = 'questions-audit.ts';

  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  STEP 4: Quality Audit — ${auditorLabel} (pending → active/flagged)  │`);
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const args = ['--write-db', '--pending-only', '--unit', unitId, '--auditor', options.auditor];
  if (options.batchId) {
    args.push('--batch-id', options.batchId);
  }
  args.push(...targetArgs(options), ...loggingArgs(options));
  console.log(`  🔍 Auditing pending questions for ${unitId} (${auditorLabel})`);
  console.log(`  🚀 Running: npx tsx apps/pipeline/src/commands/${auditScript} ${args.join(' ')}\n`);

  if (options.dryRun) {
    console.log(`  [DRY RUN] Would audit pending questions with ${auditorLabel} and promote to active/flagged`);
    return { success: true };
  }

  return runScriptAsync(auditScript, args);
}

// ─── Step 5: Learning Resource Extraction ────────────────────────────────────

export async function stepExtractResources(
  unitId: string,
  options: StepOptions
): Promise<{ success: boolean }> {
  console.log('\n┌─────────────────────────────────────────────────────────────┐');
  console.log('│  STEP 5: Learning Resource Extraction                       │');
  console.log('└─────────────────────────────────────────────────────────────┘\n');

  const resourceArgs = ['--unit', unitId, '--write-db', ...targetArgs(options), ...loggingArgs(options)];
  const result = runScript('content-extract-resources.ts', resourceArgs, options.dryRun);
  if (!result.success) {
    console.log('\n  ⚠️  Resource extraction failed (non-fatal)');
  }
  return { success: result.success };
}

// ─── Per-unit run summary ────────────────────────────────────────────────────

/**
 * Outcome of running the pipeline for one unit. `warnings` covers steps that
 * are documented as non-fatal (quality audit, resource extraction) — they
 * don't flip `success` to false, but are surfaced in the run summary.
 */
export interface UnitPipelineResult {
  unitId: string;
  success: boolean;
  failedStep?: string;
  warnings: string[];
}

export interface PipelineRunSummary {
  lines: string[];
  exitCode: 0 | 1;
}

/**
 * Build the printable summary and exit code for a full pipeline run.
 * Pure function of the per-unit results so it can be tested without
 * spawning any child scripts.
 */
export function summarizePipelineRun(results: UnitPipelineResult[]): PipelineRunSummary {
  const failed = results.filter((r) => !r.success);
  const warned = results.filter((r) => r.warnings.length > 0);

  const lines: string[] = [];
  lines.push('Summary:');
  lines.push(`  Units processed: ${results.length}`);
  lines.push(`  Succeeded:       ${results.length - failed.length}`);
  lines.push(`  Failed:          ${failed.length}`);

  if (failed.length > 0) {
    lines.push('');
    lines.push('Failed units:');
    for (const r of failed) {
      lines.push(`  - ${r.unitId}: ${r.failedStep ?? 'unknown step'}`);
    }
  }

  if (warned.length > 0) {
    lines.push('');
    lines.push('Warnings (non-fatal):');
    for (const r of warned) {
      for (const w of r.warnings) {
        lines.push(`  - ${r.unitId}: ${w}`);
      }
    }
  }

  return { lines, exitCode: failed.length > 0 ? 1 : 0 };
}
