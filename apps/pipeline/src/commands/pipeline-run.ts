/**
 * Controller script for the content regeneration pipeline
 *
 * Orchestrates:
 * 1. PDF → Markdown conversion (lib/pdf-conversion.ts)
 * 2. Topic extraction & validation (content-suggest-topics.ts)
 * 3. Question generation (questions-generate.ts)
 * 4. Quality audit (questions-audit.ts)
 * 5. Learning resource extraction (content-extract-resources.ts)
 */

import fs from 'fs';
import type { Unit } from '@adaptive/shared/types';
import { bootstrapCommand } from '../lib/command-bootstrap';
import { MARKDOWN_DIR, PDF_DIR } from '../lib/unit-discovery';
import {
  stepConvertPdf,
  stepExtractTopics,
  stepAutoUpdateFiles,
  stepGenerateQuestions,
  stepAuditQuestions,
  stepExtractResources,
  summarizePipelineRun,
  StepOptions,
  UnitPipelineResult,
} from '../lib/pipeline-steps';
import { runScript } from '../lib/script-runner';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('pipeline-run');

interface PipelineOptions extends StepOptions {
  unitId: string | '--all';
  audit: boolean;
}

const BANNER = `
╔════════════════════════════════════════════════════════════════╗
║              CONTENT REGENERATION PIPELINE                     ║
╚════════════════════════════════════════════════════════════════╝
`;
export const cli = defineCli(
  {
    unit: { type: 'string', positional: true, help: 'Unit id to process (alternative to --all)' },
    all: { type: 'boolean', default: false, help: 'Process every known unit' },
    'review-topics': {
      type: 'boolean',
      default: false,
      help: 'Interactive topic review (for domain experts only)',
    },
    'skip-convert': { type: 'boolean', default: false, help: 'Skip PDF conversion (use existing markdown)' },
    'force-convert': {
      type: 'boolean',
      default: false,
      help: 'Force PDF reconversion even if markdown exists',
    },
    'skip-topics': {
      type: 'boolean',
      default: false,
      help: 'Skip topic extraction (use existing topics from DB)',
    },
    ...dbTargetFlags,
    ...loggingFlags,
    audit: { type: 'boolean', default: false, help: 'Run quality audit after generation (requires --write-db)' },
    auditor: {
      type: 'string',
      choices: ['mistral', 'sonnet'] as const,
      default: 'mistral',
      help: "Audit model: 'mistral' (default) or 'sonnet'",
    },
    'skip-resources': { type: 'boolean', default: false, help: 'Skip learning resource extraction' },
    'dry-run': { type: 'boolean', default: false, help: 'Show what would be done without executing' },
    'convert-only': {
      type: 'boolean',
      default: false,
      help: 'Stop after PDF conversion (skip topics, generation, audit)',
    },
    'batch-id': { type: 'string', help: 'Custom batch ID' },
    'markdown-file': { type: 'string', help: 'Use specified markdown file (bypasses PDF conversion)' },
  },
  {
    name: 'pipeline-run',
    description: 'Run the full content pipeline for a unit: convert PDF, extract topics, generate questions, and audit.',
    banner: BANNER,
    helpOnEmptyArgv: true,
    examples: [
      'npx tsx apps/pipeline/src/commands/pipeline-run.ts unit-4                    # Full pipeline for unit-4',
      'npx tsx apps/pipeline/src/commands/pipeline-run.ts unit-4 --write-db         # Generate and sync to DB',
      'npx tsx apps/pipeline/src/commands/pipeline-run.ts unit-4 --write-db --audit # Generate, sync, and audit',
      'npx tsx apps/pipeline/src/commands/pipeline-run.ts unit-4 --skip-convert --write-db',
      'npx tsx apps/pipeline/src/commands/pipeline-run.ts --all --write-db          # Regenerate all units',
    ],
    validate: (o) => {
      if (o.all && o.unit) return 'Pass a unit id or --all, not both';
      if (o.audit && !o.writeDb) return '--audit requires --write-db (questions must be in DB to audit)';
    },
  },
);

/**
 * Run the pipeline for a single unit
 */
async function runPipelineForUnit(
  unitId: string,
  options: PipelineOptions,
  units: Unit[]
): Promise<UnitPipelineResult> {
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  PROCESSING: ${unitId.toUpperCase()}`);
  console.log(`${'═'.repeat(65)}`);

  const warnings: string[] = [];

  // Step 1: Convert PDF
  const step1 = await stepConvertPdf(unitId, options, units);
  if (!step1.success || !step1.markdownPath) {
    console.log('\n  ❌ Pipeline stopped: No markdown available');
    return { unitId, success: false, failedStep: 'PDF conversion', warnings };
  }

  // --convert-only: stop after PDF conversion
  if (options.convertOnly) {
    console.log('\n  ✅ Conversion complete (--convert-only)');
    return { unitId, success: true, warnings };
  }

  // Step 2: Extract topics
  const step2 = await stepExtractTopics(unitId, step1.markdownPath, options, units);
  if (!step2.success) {
    console.log('\n  ❌ Pipeline stopped at topic extraction');
    return { unitId, success: false, failedStep: 'topic extraction', warnings };
  }

  // Step 2.5: Auto-update DB (only for new units)
  let topics = step2.topics || [];
  const existingUnit = units.find(u => u.id === unitId);
  if (!existingUnit) {
    const step2_5 = await stepAutoUpdateFiles(unitId, options, units, step1.sourceFileStem);
    if (!step2_5.success) {
      console.log('\n  ❌ Pipeline stopped at source file update');
      return { unitId, success: false, failedStep: 'source file update', warnings };
    }
    topics = step2_5.topics || topics;
  }

  // Step 3: Generate questions
  const step3 = await stepGenerateQuestions(unitId, topics, options, units);
  if (!step3.success) {
    console.log('\n  ❌ Question generation failed');
    return { unitId, success: false, failedStep: 'question generation', warnings };
  }

  // Step 4: Quality audit (optional, non-fatal — questions remain pending on failure)
  if (options.audit) {
    const step4 = await stepAuditQuestions(unitId, options);
    if (!step4.success) {
      console.log('\n  ⚠️  Quality audit failed (questions remain as pending)');
      warnings.push('quality audit failed (questions remain as pending)');
    }
  }

  // Step 5: Learning resource extraction (default, skip with --skip-resources; non-fatal)
  if (!options.skipResources && options.writeDb) {
    const step5 = await stepExtractResources(unitId, options);
    if (!step5.success) {
      warnings.push('resource extraction failed');
    }
  }

  console.log('\n  ✅ Pipeline complete for', unitId);
  return { unitId, success: true, warnings };
}

/**
 * Discover unit IDs from local files when the units table is empty.
 * Checks markdown files in content/markdown/ first, falls back to PDF filenames.
 */
function discoverUnitsFromFiles(): string[] {
  const ids = new Set<string>();

  // Try markdowns first
  if (fs.existsSync(MARKDOWN_DIR)) {
    const mdFiles = fs.readdirSync(MARKDOWN_DIR)
      .filter(f => f.endsWith('.md'));
    for (const file of mdFiles) {
      if (/introduction/i.test(file)) { ids.add('introduction'); continue; }
      const unitMatch = file.match(/unit[_\s-]?(\d+)/i);
      if (unitMatch) ids.add(`unit-${unitMatch[1]}`);
    }
  }

  // Fall back to PDF filenames if no markdowns found
  if (ids.size === 0 && fs.existsSync(PDF_DIR)) {
    const pdfFiles = fs.readdirSync(PDF_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'));
    for (const file of pdfFiles) {
      if (/introduction/i.test(file)) { ids.add('introduction'); continue; }
      const unitMatch = file.match(/unit[_\s-]?(\d+)/i);
      if (unitMatch) ids.add(`unit-${unitMatch[1]}`);
    }
  }

  return [...ids].sort((a, b) => {
    if (a === 'introduction') return -1;
    if (b === 'introduction') return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/**
 * Main function
 */
export async function main() {
  const { options: parsedOptions, units } = await bootstrapCommand(cli, { units: true });
  const options: PipelineOptions & { verbose: boolean; quiet: boolean } = {
    ...parsedOptions,
    // Neither --all nor a unit id (positional or --unit) was given — resolved downstream as an
    // unrecognized unit, same as any other unit id that doesn't match a known unit.
    unitId: parsedOptions.all ? '--all' : (parsedOptions.unit ?? ''),
  };

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
  console.log(`  Write to DB:   ${options.writeDb ? 'Yes' : 'No'}`);
  console.log(`  Audit:         ${options.audit ? `Yes — ${options.auditor === 'mistral' ? 'Mistral Large' : 'Sonnet'} (pending → active/flagged)` : 'No'}`);
  console.log(`  Resources:     ${options.skipResources ? 'Skip' : 'Yes (extract from markdown)'}`);
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

  const results: UnitPipelineResult[] = [];

  if (options.unitId === '--all') {
    // Discover unit IDs: prefer DB, fall back to local files
    let unitIds = units.map(u => u.id);
    if (unitIds.length === 0) {
      unitIds = discoverUnitsFromFiles();
      if (unitIds.length === 0) {
        logger.error('No units in database and no files found in content/markdown/ or content/pdf/');
        process.exit(1);
      }
      console.log(`  No units in DB — discovered ${unitIds.length} from files: ${unitIds.join(', ')}`);
    }

    // Keep processing remaining units when one fails, so a single bad unit
    // doesn't hide results for the rest of the batch.
    for (const id of unitIds) {
      results.push(await runPipelineForUnit(id, options, units));
    }

    // Post-processing: cross-unit topic consolidation
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│  POST: Cross-Unit Topic Consolidation                      │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    const consolidationResult = runScript('content-suggest-topics.ts', ['--consolidate'], options.dryRun);
    if (consolidationResult.output) {
      console.log(consolidationResult.output);
    }
    if (!consolidationResult.success) {
      logger.error('Cross-unit topic consolidation failed', { error: consolidationResult.error });
    }
  } else {
    // Validate unit exists in DB or has matching files on disk
    const existingUnit = units.find(u => u.id === options.unitId);
    if (!existingUnit && !discoverUnitsFromFiles().includes(options.unitId)) {
      logger.error(`Unknown unit ID: ${options.unitId}`, {
        discoveredUnits: discoverUnitsFromFiles(),
      });
      console.log('   No matching files in content/markdown/ or content/pdf/');
      process.exit(1);
    }

    results.push(await runPipelineForUnit(options.unitId, options, units));
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log('  PIPELINE COMPLETE');
  console.log(`${'═'.repeat(65)}\n`);

  const summary = summarizePipelineRun(results);
  for (const line of summary.lines) {
    console.log(line);
  }

  if (summary.exitCode !== 0) {
    process.exit(summary.exitCode);
  }
}

runIfMain(import.meta.url, main);
