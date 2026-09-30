/**
 * Exports a frozen eval set's items for a human reviewer to fill in reference. Audit and grading get a
 * blind reviewer sheet — `.xlsx` by default, `.csv` with `--format csv` — with no `quality_status`,
 * no `audit_metadata`, no production verdict, no `selection_pool` tag, and (for grading) no
 * `label_class`: nothing that reveals a model's or production's own opinion of the item. Row order
 * is shuffled with a seed (printed, or passed via --seed to reproduce a shuffle) so a reviewer
 * working through the sheet top to bottom doesn't see items grouped by however they were sampled;
 * grading rows are additionally grouped by source question, each group's answers shuffled within
 * it. The `.xlsx` sheet carries bold headers, an italic per-column description row, both frozen,
 * hidden `item_id`/`difficulty` columns, dropdown validation on the verdict columns, wrapped text
 * on the long ones, and sheet protection unlocking only the input columns.
 *
 * Transcription gets a directory instead — one `<slide>.md` file per item, since a transcript is
 * reviewed against the slide image, not a row of cells — prefilled with `--from-run`'s output when
 * given, plus a README.md listing every slide and its category.
 *
 * Read-only. `eval_sets`/`eval_items` are service-role only (no anon-readable policy), so this
 * still goes through the write-capable Supabase client the same way every other eval command's dry
 * run does — nothing here performs a write.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore } from '../lib/eval/db';
import { POLICY_LABEL_CLASSES, type GradingLabelClass } from '../lib/eval/set-builder';
import { AUDIT_COLUMNS, GRADING_COLUMNS, buildAuditReferenceRows, buildGradingReferenceRows, type ReferenceRow } from '../lib/eval/review-export';
import { writeReferenceWorkbook, type ReferenceColumn } from '../lib/eval/workbook';
import { writeCsv } from '../lib/eval/csv';
import { buildTranscriptionReferenceExportFiles, buildTranscriptionReferenceReadme } from '../lib/eval/transcription-review';
import { guardTrackedTreeWrite } from '../lib/eval/paths';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-review-export');

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    set: { type: 'string', required: true, help: 'eval_sets id to export' },
    out: { type: 'string', required: true, help: 'Reviewer sheet output path (audit/grading), or a directory (transcription)' },
    format: {
      type: 'string',
      choices: ['xlsx', 'csv'],
      default: 'xlsx',
      help: 'Audit/grading output format: an .xlsx workbook (headers, descriptions, validation, protection) or a flat .csv',
    },
    seed: { type: 'number', help: 'Random seed shuffling row order (default: a fresh seed, printed to the console) — audit/grading only' },
    'all-classes': {
      type: 'boolean',
      default: false,
      help: "Grading task: include typo/missing_accent items (excluded by default — see eval-review-import --policy-labels)",
    },
    'from-run': { type: 'string', help: "Transcription task: eval_runs id whose output prefills each slide's file (default: empty files)" },
  },
  {
    name: 'eval-review-export',
    description: "Exports a frozen eval set's items for a reviewer to fill in reference: an .xlsx or .csv sheet for audit/grading, a directory of per-slide markdown files for transcription.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-review-export.ts --set <id> --out .private/eval/references/unit-1-audit-reference.xlsx',
      'npx tsx apps/pipeline/src/commands/eval-review-export.ts --set <id> --out .private/eval/references/unit-1-audit-reference.csv --format csv',
      'npx tsx apps/pipeline/src/commands/eval-review-export.ts --set <id> --out .private/eval/references/unit-1-transcription-reference --from-run <baseline-run-id>',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

/** Writes the description row plus every data row, in column order, to a `.csv` document — the
 * same layout `writeReferenceWorkbook` produces as a workbook, so `eval-review-import` can treat either
 * format's row 2 as the description row to skip. */
function writeReferenceCsv(columns: ReferenceColumn[], rows: ReferenceRow[]): string {
  const header = columns.map((c) => c.name);
  const descriptionRow = columns.map((c) => c.description);
  const dataRows = rows.map((row) => columns.map((c) => row[c.name] ?? ''));
  return writeCsv(header, [descriptionRow, ...dataRows]);
}

/** Transcription's directory-based export: one `<slide>.md` file per item, prefilled with
 * `--from-run`'s output when given, plus a README.md listing every slide and its category.
 * `outDir` is `options.out` already resolved and checked by `guardTrackedTreeWrite`. */
async function runTranscriptionReferenceExport(options: Options, store: ReturnType<typeof createSupabaseEvalStore>, outDir: string): Promise<void> {
  const items = await store.listItems(options.set);
  if (items.length === 0) {
    logger.warn('No items to export. Exiting.');
    return;
  }

  let outputsByItem: Map<string, string> | undefined;
  if (options.fromRun) {
    const results = await store.listResults(options.fromRun);
    outputsByItem = new Map();
    for (const r of results) {
      const markdown = (r.output as { markdown?: string } | null)?.markdown;
      if (typeof markdown === 'string') outputsByItem.set(r.item_id, markdown);
    }
  }

  mkdirSync(outDir, { recursive: true });
  const files = buildTranscriptionReferenceExportFiles(items, outputsByItem);
  for (const file of files) {
    writeFileSync(join(outDir, file.filename), file.content);
  }
  writeFileSync(join(outDir, 'README.md'), buildTranscriptionReferenceReadme(options.set, items, options.fromRun));

  console.log(
    `Wrote ${files.length} slide file(s) plus README.md to ${outDir}` +
    `${options.fromRun ? ` (prefilled from run ${options.fromRun})` : ' (empty — no --from-run given)'}.`,
  );
}

/**
 * `store` and `argv` are injection points for tests (a fake `EvalStore`) so the write-guard refusal
 * and the export paths are testable without a live Supabase connection. Production use (`runIfMain`
 * below) supplies neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  // Resolved and checked once, before any of this command's five write sites (directory-mode's
  // mkdirSync + two writeFileSync calls, or the xlsx/csv branch's one writeFileSync) and before any
  // store access — see guardTrackedTreeWrite's own doc comment.
  let outPath: string;
  try {
    outPath = guardTrackedTreeWrite(options.out);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // eval_* tables are service-role only, read or write. Real Supabase access is skipped entirely
  // when a store is injected, so a test never needs live credentials or a network connection.
  const store = deps.store ?? createSupabaseEvalStore(createScriptSupabase({ write: true }));

  const set = await store.getSet(options.set);
  if (!set) {
    logger.error(`No eval set found with id ${options.set}`);
    process.exit(1);
  }
  if (set.task !== 'audit' && set.task !== 'grading' && set.task !== 'transcription') {
    logger.error(`eval-review-export supports 'audit', 'grading', and 'transcription' tasks only (got '${set.task}').`);
    process.exit(1);
  }

  if (options.fromRun && set.task !== 'transcription') {
    logger.error(`--from-run applies to the transcription task only (set ${options.set} is ${set.task}).`);
    process.exit(1);
  }

  if (set.task === 'transcription') {
    await runTranscriptionReferenceExport(options, store, outPath);
    return;
  }

  if (options.allClasses && set.task !== 'grading') {
    logger.error(`--all-classes applies to the grading task only (set ${options.set} is ${set.task}).`);
    process.exit(1);
  }

  let items = await store.listItems(options.set);
  if (set.task === 'grading' && !options.allClasses) {
    // The app's fuzzy-match tier already accepts these by policy (see
    // `eval-review-import --policy-labels`), so a reviewer has nothing to judge on them.
    const before = items.length;
    items = items.filter((i) => !(POLICY_LABEL_CLASSES as readonly string[]).includes(i.payload.label_class as GradingLabelClass));
    if (before !== items.length) {
      console.log(`Excluding ${before - items.length} policy-labelled item(s) (typo/missing_accent) — pass --all-classes to include them.`);
    }
  }

  if (items.length === 0) {
    logger.warn('No items to export. Exiting.');
    return;
  }

  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);

  const columns = set.task === 'audit' ? AUDIT_COLUMNS : GRADING_COLUMNS;
  let rows: ReferenceRow[];
  if (set.task === 'audit') {
    const built = buildAuditReferenceRows(items, seed);
    for (const warning of built.warnings) logger.warn(warning);
    rows = built.rows;
  } else {
    rows = buildGradingReferenceRows(items, seed);
  }

  if (options.format === 'xlsx') {
    const sheetName = set.task === 'audit' ? 'Audit review' : 'Grading review';
    writeFileSync(outPath, await writeReferenceWorkbook(sheetName, columns, rows));
  } else {
    writeFileSync(outPath, writeReferenceCsv(columns, rows));
  }
  console.log(`Wrote ${rows.length} row(s) to ${outPath} (${options.format}, shuffled with seed ${seed}).`);
}

runIfMain(import.meta.url, main);
