/**
 * Creates a frozen, hashed item sample (`eval_sets` + `eval_items`) for the audit, grading,
 * mapping, or transcription task. Dry run by default — prints what would be sampled and how it
 * stratifies; pass --write-db to persist it.
 *
 * --task audit: stratified sample of `questions` (type × difficulty × quality_status by
 * default), snapshotting each question's fields plus its production audit verdict for a
 * production-verdict comparison. --balance-status splits the sample 50/50 between flagged and
 * non-flagged questions first, then stratifies each half — a proportional sample would
 * under-represent flagged questions, which are the minority in production.
 *
 * --task grading: one item per (active fill-in-blank/writing question × label class), with an
 * empty submitted_answer placeholder for `eval-seed-grading` to fill in.
 *
 * --task mapping: one item per topic of --unit, reference set immediately from the unit's current,
 * already-validated headings — there's no reviewer step, so this task always writes reference at
 * creation, unlike audit/grading. Refuses if any topic has no headings, since that's a broken
 * topic-heading link rather than something to silently score against an empty reference set.
 *
 * --task transcription: draws --per-category slides from each of three slide categories —
 * image-dominated and text slides come straight from --report's own categorization; a third "mixed"
 * category production doesn't track itself is derived from text-layer length (see
 * `categorizeTranscriptionSlides`). Reference is left pending — a checked transcript is filled in later
 * via `eval-review-export`/`eval-review-import`, never known at creation time.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase, fetchAllPages } from '../lib/db-queries';
import { fetchUnitsFromDb } from '../lib/units-db';
import { createSupabaseEvalStore, type EvalStore } from '../lib/eval/db';
import { stratifiedSample } from '../lib/eval/sampling';
import { extractSlideText } from '../lib/pdf-conversion';
import {
  buildAuditItems,
  buildGradingItems,
  buildMappingItems,
  buildTranscriptionItems,
  categorizeTranscriptionSlides,
  drawTranscriptionSample,
  hashInputs,
  hashInputsForUnits,
  hashPdfBytes,
  strataKeyFn,
  excludeTopics,
  drawSelectionPool,
  auditPayload,
  GRADING_LABEL_CLASSES,
  TRANSCRIPTION_CATEGORIES,
  type AuditSourceQuestion,
  type GradingSourceQuestion,
  type BuiltEvalItem,
  type TranscriptionConversionReport,
  type TranscriptionSlideInfo,
} from '../lib/eval/set-builder';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-set-create');

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    task: {
      type: 'string',
      choices: ['audit', 'grading', 'mapping', 'transcription'] as const,
      required: true,
      help: 'Which task this set samples items for',
    },
    'from-batch': { type: 'string', help: 'Restrict to questions from this batch_id' },
    unit: { type: 'string', help: 'Unit id this set is drawn from, recorded as eval_sets.unit_id (required)' },
    markdown: { type: 'string', help: 'Path to the unit markdown file (required for --task mapping)' },
    strata: {
      type: 'string',
      default: 'type,difficulty,quality_status',
      help: 'Comma-separated question fields to stratify the audit sample by',
    },
    size: { type: 'number', min: 1, help: 'Sample size: questions for --task audit (required); questions before label classes for --task grading (default: all)' },
    seed: { type: 'number', help: 'Random seed for the sample — recorded either way; omit to generate one' },
    'include-ids': { type: 'string', help: 'Path to a file of question ids (one per line) to restrict sampling to (audit)' },
    'exclude-topics': { type: 'string', help: 'Path to a file of topic names (one per line, exact match) to exclude from the audit candidate pool before sampling' },
    'balance-status': {
      type: 'boolean',
      default: false,
      help: 'Oversample flagged questions to half the audit sample',
    },
    'pool-ids': { type: 'string', help: 'Path to a file of candidate ids (one per line) to draw --pool-size additional items from, uniformly at random, after the stratified --size core (audit)' },
    'pool-size': { type: 'number', min: 1, help: 'Additional items to draw from --pool-ids beyond the stratified core, tagged payload.selection_pool: "pool" (audit; requires --pool-ids)' },
    'per-question': {
      type: 'number',
      default: GRADING_LABEL_CLASSES.length,
      min: 1,
      help: `Grading label classes to seed per question, taken in order (max ${GRADING_LABEL_CLASSES.length})`,
    },
    pdf: { type: 'string', help: 'Path to the source PDF (required for --task transcription)' },
    report: { type: 'string', help: 'Path to that PDF\'s *.conversion-report.json (required for --task transcription)' },
    'per-category': { type: 'number', min: 1, help: 'Slides to draw from each of the three slide categories (required for --task transcription)' },
    label: { type: 'string', required: true, help: 'Human-readable label for this set' },
  },
  {
    name: 'eval-set-create',
    description: 'Creates a frozen, hashed item sample (eval_sets/eval_items) for the audit, grading, mapping, or transcription task.',
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-set-create.ts --task audit --from-batch unit-1-batch --unit unit-1 --strata type,difficulty,quality_status --size 150 --balance-status --label "unit-1 audit reference candidate" --write-db',
      'npx tsx apps/pipeline/src/commands/eval-set-create.ts --task grading --from-batch unit-1-batch --unit unit-1 --per-question 6 --label "unit-1 grading reference candidate" --write-db',
      'npx tsx apps/pipeline/src/commands/eval-set-create.ts --task mapping --unit unit-1 --markdown "apps/pipeline/content/markdown/Unit 1.md" --label "unit-1 heading mapping" --write-db',
      'npx tsx apps/pipeline/src/commands/eval-set-create.ts --task transcription --unit unit-1 --pdf apps/pipeline/content/pdf/Unit\\ 1.pdf --report "apps/pipeline/content/markdown/Unit 1.conversion-report.json" --per-category 10 --label "unit-1 transcription" --write-db',
    ],
    validate: (o) => {
      if (!o.unit) return 'Error: --unit is required';
      if (o.task === 'audit' && !o.size) return 'Error: --size is required for --task audit';
      if (o.task === 'mapping' && !o.markdown) {
        return 'Error: --markdown is required for --task mapping';
      }
      if (o.task === 'transcription' && (!o.pdf || !o.report || !o.perCategory)) {
        return 'Error: --pdf, --report, and --per-category are required for --task transcription';
      }
      if (o.perQuestion > GRADING_LABEL_CLASSES.length) {
        return `Error: --per-question can be at most ${GRADING_LABEL_CLASSES.length} (the number of label classes)`;
      }
      if (!!o.poolIds !== !!o.poolSize) {
        return 'Error: --pool-ids and --pool-size must be given together';
      }
    },
  },
);

type Options = ReturnType<typeof cli.parse>;

function parseStrataFlag(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Reads a newline-delimited file into a set of trimmed, non-blank lines — used for id lists
 * (`--include-ids`, `--pool-ids`) and topic-name lists (`--exclude-topics`) alike. */
function readLines(path: string): Set<string> {
  return new Set(
    readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

async function runAuditSetCreate(options: Options, supabase: ReturnType<typeof createScriptSupabase>, store: EvalStore): Promise<void> {
  const questions = await fetchAllPages<AuditSourceQuestion>(
    supabase,
    'questions',
    (query) => {
      let q = query;
      if (options.fromBatch) q = q.eq('batch_id', options.fromBatch);
      if (options.unit) q = q.eq('unit_id', options.unit);
      return q;
    },
    'id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, options, acceptable_variations, quality_status, audit_metadata',
  );

  const includeIds = options.includeIds ? readLines(options.includeIds) : undefined;
  let pool = includeIds ? questions.filter((q) => includeIds.has(q.id)) : questions;

  const excludedTopics = options.excludeTopics ? readLines(options.excludeTopics) : undefined;
  if (excludedTopics) {
    const before = pool.length;
    pool = excludeTopics(pool, excludedTopics);
    console.log(`Excluded ${before - pool.length} question(s) in ${excludedTopics.size} excluded topic(s).`);
  }

  if (pool.length === 0) {
    logger.warn('No candidate questions found. Exiting.');
    return;
  }

  const strata = parseStrataFlag(options.strata);
  const built = buildAuditItems(pool, {
    size: options.size!,
    strata,
    seed: options.seed,
    balanceStatus: options.balanceStatus,
  });

  console.log(`Sampled ${built.items.length} of ${pool.length} candidate questions (seed ${built.seed}).`);
  console.log('\nStrata:');
  for (const [key, count] of Object.entries(built.strataCounts).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${key}: ${count}`);
  }

  let finalItems: BuiltEvalItem[] = built.items;
  if (options.poolIds && options.poolSize) {
    const poolIds = readLines(options.poolIds);
    const candidateIds = new Set(pool.map((q) => q.id));
    const coreIds = new Set(built.items.map((i) => i.itemKey));
    const draw = drawSelectionPool(candidateIds, {
      poolIds,
      poolSize: options.poolSize,
      seed: built.seed,
      excludeIds: coreIds,
    });
    const questionById = new Map(pool.map((q) => [q.id, q]));
    const poolItems: BuiltEvalItem[] = draw.ids.map((id) => ({
      itemKey: id,
      payload: { ...auditPayload(questionById.get(id)!), selection_pool: 'pool' },
    }));
    const coreItems: BuiltEvalItem[] = built.items.map((i) => ({ ...i, payload: { ...i.payload, selection_pool: 'core' } }));
    finalItems = [...coreItems, ...poolItems];

    console.log(`\nDrew ${poolItems.length} of --pool-size ${options.poolSize} additional pool item(s) from ${options.poolIds} (ignored ${draw.ignoredCount} id(s) not in the filtered candidate pool).`);
  }

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this set.');
    return;
  }

  const units = await fetchUnitsFromDb(supabase);
  const touchedUnitIds = finalItems.map((i) => i.payload.unit_id as string);
  const inputsHash = hashInputsForUnits(touchedUnitIds, units);

  const setRow = await store.insertSet({
    task: 'audit',
    source: options.fromBatch ?? 'all',
    unit_id: options.unit ?? null,
    item_count: finalItems.length,
    selection: {
      strata,
      seed: built.seed,
      size: options.size,
      balanceStatus: options.balanceStatus,
      fromBatch: options.fromBatch ?? null,
      includeIds: !!options.includeIds,
      excludedTopics: excludedTopics ? [...excludedTopics] : null,
      poolSize: options.poolSize ?? null,
      poolIdsFile: options.poolIds ?? null,
    },
    inputs_hash: inputsHash,
    label: options.label,
  });
  await store.insertItems(finalItems.map((i) => ({ set_id: setRow.id, item_key: i.itemKey, payload: i.payload })));

  console.log(`\nCreated eval set ${setRow.id} (${finalItems.length} items).`);
}

async function runGradingSetCreate(options: Options, supabase: ReturnType<typeof createScriptSupabase>, store: EvalStore): Promise<void> {
  const questions = await fetchAllPages<GradingSourceQuestion>(
    supabase,
    'questions',
    (query) => {
      let q = query.in('type', ['fill-in-blank', 'writing']).eq('quality_status', 'active');
      if (options.fromBatch) q = q.eq('batch_id', options.fromBatch);
      if (options.unit) q = q.eq('unit_id', options.unit);
      return q;
    },
    'id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, acceptable_variations',
  );

  if (questions.length === 0) {
    logger.warn('No active fill-in-blank/writing questions found. Exiting.');
    return;
  }

  // Stratify by type and difficulty so a small question sample still covers every cell.
  const sampled = options.size
    ? stratifiedSample(questions, { size: options.size, keyFn: strataKeyFn<GradingSourceQuestion>(['type', 'difficulty']), seed: options.seed })
    : { items: questions, seed: options.seed ?? null, strataCounts: null };
  const items = buildGradingItems(sampled.items, { perQuestion: options.perQuestion });
  console.log(`Built ${items.length} grading items from ${sampled.items.length} of ${questions.length} questions (${options.perQuestion} label class(es) each${sampled.seed !== null ? `, seed ${sampled.seed}` : ''}).`);
  if (sampled.strataCounts) {
    console.log('\nStrata:');
    for (const [key, count] of Object.entries(sampled.strataCounts).sort()) console.log(`  ${key}: ${count}`);
  }

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this set. Every item stays reference_status \'pending\'; run eval-seed-grading next, then approve in the Supabase table editor.');
    return;
  }

  const units = await fetchUnitsFromDb(supabase);
  const touchedUnitIds = sampled.items.map((q) => q.unit_id);
  const inputsHash = hashInputsForUnits(touchedUnitIds, units);

  const setRow = await store.insertSet({
    task: 'grading',
    source: options.fromBatch ?? 'all',
    unit_id: options.unit ?? null,
    item_count: items.length,
    selection: {
      perQuestion: options.perQuestion,
      fromBatch: options.fromBatch ?? null,
      size: options.size ?? null,
      seed: sampled.seed,
      strata: sampled.strataCounts ? ['type', 'difficulty'] : null,
    },
    inputs_hash: inputsHash,
    label: options.label,
  });
  await store.insertItems(items.map((i) => ({ set_id: setRow.id, item_key: i.itemKey, payload: i.payload, seeded_class: i.seededClass ?? null })));

  console.log(`\nCreated eval set ${setRow.id} (${items.length} items). Every item is reference_status 'pending' — run eval-seed-grading, then approve in the Supabase table editor.`);
}

async function runMappingSetCreate(options: Options, supabase: ReturnType<typeof createScriptSupabase>, store: EvalStore): Promise<void> {
  const units = await fetchUnitsFromDb(supabase);
  const unit = units.find((u) => u.id === options.unit);
  if (!unit) {
    logger.error(`Unit ${options.unit} not found in DB.`);
    process.exit(1);
  }

  const markdown = readFileSync(options.markdown!, 'utf-8');
  const built = buildMappingItems(unit);

  if (built.topicsWithNoHeadings.length > 0) {
    logger.error(
      `${built.topicsWithNoHeadings.length} topic(s) in ${options.unit} have no headings — repair them with ` +
      `content-suggest-topics --map-existing before building a mapping eval set: ${built.topicsWithNoHeadings.join(', ')}`,
    );
    process.exit(1);
  }

  console.log(`Built ${built.items.length} mapping item(s) from ${options.unit}'s topics, reference set from its current headings.`);

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this set.');
    return;
  }

  const inputsHash = hashInputs(markdown, unit);
  const setRow = await store.insertSet({
    task: 'mapping',
    source: options.unit!,
    unit_id: options.unit,
    item_count: built.items.length,
    selection: { markdownPath: options.markdown },
    inputs_hash: inputsHash,
    label: options.label,
  });
  await store.insertItems(built.items.map((i) => ({
    set_id: setRow.id,
    item_key: i.itemKey,
    payload: i.payload,
    reference: i.reference,
    reference_status: i.referenceStatus,
    reviewed_by: i.reviewedBy,
    reviewed_at: i.reviewedAt,
  })));

  console.log(`\nCreated eval set ${setRow.id} (${built.items.length} items), reference already approved.`);
}

async function runTranscriptionSetCreate(options: Options, storeOverride?: EvalStore): Promise<void> {
  const pdfPath = options.pdf!;
  const reportPath = options.report!;
  const perCategory = options.perCategory!;

  const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as TranscriptionConversionReport;
  const pdfBytes = readFileSync(pdfPath);
  const pdfName = path.basename(pdfPath, path.extname(pdfPath));

  const slides: TranscriptionSlideInfo[] = Array.from({ length: report.slideCount }, (_, i) => i + 1)
    .map((slide) => ({ slide, textLayer: extractSlideText(pdfPath, slide) }));
  const textLayerBySlide = new Map(slides.map((s) => [s.slide, s.textLayer]));

  const categorized = categorizeTranscriptionSlides(slides, report);
  console.log(
    `${pdfName}: ${report.slideCount} slide(s) — ${categorized.imageDominated.length} image-dominated, ` +
    `${categorized.text.length} text, ${categorized.mixed.length} mixed (report: ${report.flaggedSlides.length} flagged, ${report.skippedSlides.length} skipped).`,
  );

  const draw = drawTranscriptionSample(categorized, { perCategory, seed: options.seed });
  console.log(`\nDrew ${perCategory} slide(s) per category (seed ${draw.seed}):`);
  for (const category of TRANSCRIPTION_CATEGORIES) {
    console.log(`  ${category}: ${draw.slides[category].join(', ')}`);
  }

  const flaggedSlides = new Set(report.flaggedSlides.map((s) => s.slide));
  const items = buildTranscriptionItems({ pdfName, slides: draw.slides, textLayerBySlide, flaggedSlides });

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this set.');
    return;
  }

  const store = storeOverride ?? createSupabaseEvalStore(createScriptSupabase({ write: true })); // eval_* tables are service-role only
  const inputsHash = hashPdfBytes(pdfBytes);
  const setRow = await store.insertSet({
    task: 'transcription',
    source: pdfName,
    unit_id: options.unit ?? null,
    item_count: items.length,
    selection: {
      pdfPath,
      reportPath,
      perCategory,
      seed: draw.seed,
      categories: Object.fromEntries(TRANSCRIPTION_CATEGORIES.map((c) => [c, draw.slides[c]])),
    },
    inputs_hash: inputsHash,
    label: options.label,
  });
  await store.insertItems(items.map((i) => ({ set_id: setRow.id, item_key: i.itemKey, payload: i.payload })));

  console.log(`\nCreated eval set ${setRow.id} (${items.length} items). Reference is pending — run eval-review-export/eval-review-import once a baseline run exists.`);
}

/**
 * `store` and `argv` are injection points for tests (a fake `EvalStore`) so the sampling and
 * eval_sets/eval_items write paths are testable without a live Supabase connection. Production use
 * (`runIfMain` below) supplies neither, so both default to the real thing. The audit/grading/mapping
 * tasks still open a real Supabase client for their own question/unit reads even when a store is
 * injected — only `eval_sets`/`eval_items` access goes through `store`. Transcription needs no
 * Supabase access at all for a dry run, and none beyond `store` for a write, so it stays out of that
 * client entirely when a store is injected.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  if (options.task === 'transcription') {
    await runTranscriptionSetCreate(options, deps.store);
    return;
  }

  // Full quality_status visibility (pending/flagged included) is needed even for a dry-run
  // preview — the anon key's RLS policy only exposes 'active' questions, which would silently
  // undersample exactly the rows --balance-status and audit reference sampling care about.
  const supabase = createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase);

  if (options.task === 'audit') {
    await runAuditSetCreate(options, supabase, store);
  } else if (options.task === 'grading') {
    await runGradingSetCreate(options, supabase, store);
  } else {
    await runMappingSetCreate(options, supabase, store);
  }
}

runIfMain(import.meta.url, main);
