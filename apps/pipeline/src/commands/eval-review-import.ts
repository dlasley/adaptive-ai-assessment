/**
 * Reads a reviewer's completed reference back and writes `eval_items.reference`. Audit and grading read a
 * reviewer sheet — `.xlsx` or `.csv`, detected by extension — from `eval-review-export`, skipping its
 * row-2 column descriptions; transcription reads a directory of `<slide>.md` files (from the same
 * command's directory export). Validates everything before any write — item existence and
 * uniqueness, well-formed cells or non-empty files, and a required `reason`/non-empty transcript
 * wherever one is needed — and refuses to write anything if any of it fails, rather than partially
 * applying a submission with errors in it.
 *
 * `--policy-labels` (grading only) approves every `typo`/`missing_accent` item directly, without a
 * sheet row for it: the app's fuzzy-match tier already accepts those answers by policy, so there's
 * nothing for a reviewer to judge.
 *
 * Dry run by default; `--write-db` performs the writes. An item already `reference_status: 'approved'`
 * is left alone unless `--overwrite` is given. A successful `--write-db` run also records one
 * `eval_review_rounds` row for the set, with `reviewed_item_count` set to however many items this
 * run actually wrote.
 */

import { readFileSync, readdirSync } from 'fs';
import { extname, join } from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type NewEvalReviewRoundRow } from '../lib/eval/db';
import { parseCsv, csvRowsToObjects } from '../lib/eval/csv';
import { readXlsxRows } from '../lib/eval/workbook';
import {
  validateAuditRows, validateGradingRows, isDescriptionRow,
  type AuditReferenceRow, type GradingReferenceRow, type ValidationError,
} from '../lib/eval/review-import';
import { validateTranscriptionReferenceFiles, type TranscriptionReferenceRow } from '../lib/eval/transcription-review';
import { POLICY_LABEL_CLASSES, seededLabelClass, type GradingLabelClass } from '../lib/eval/set-builder';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-review-import');

const POLICY_REASON = "policy: accepted by the app's fuzzy-match tier";

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    set: { type: 'string', required: true, help: 'eval_sets id to import reference into' },
    from: { type: 'string', required: true, help: 'Reviewer-completed .xlsx or .csv path (audit/grading), or reference directory (transcription) — all from eval-review-export' },
    reviewer: { type: 'string', required: true, help: 'Reviewer handle recorded as reviewed_by on each written item, and as the eval_review_rounds row\'s reviewer' },
    'rubric-version': { type: 'string', required: true, help: 'Label of the rubric this review round was labeled under (e.g. v1), recorded on the eval_review_rounds row' },
    'rubric-hash': { type: 'string', help: 'Content hash of the rubric at labeling time, recorded on the eval_review_rounds row' },
    'calibration-result': { type: 'string', help: 'JSON object recording this round\'s calibration result (e.g. \'{"pilot_agreement": 0.92, "pilot_item_count": 20}\'), recorded on the eval_review_rounds row' },
    sheet: { type: 'string', help: 'Worksheet (tab) to read from an .xlsx, matched exactly or by prefix (an .xlsx export truncates tab names to 31 characters); default is the first tab' },
    'policy-labels': {
      type: 'boolean',
      default: false,
      help: 'Grading task: also approve every typo/missing_accent item directly, without a sheet row for it',
    },
    overwrite: { type: 'boolean', default: false, help: "Overwrite items already reference_status 'approved' (default: skip them)" },
  },
  {
    name: 'eval-review-import',
    description: "Validates and writes a reviewer's completed reference (from eval-review-export) into eval_items.reference.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-review-import.ts --set <id> --from reviewer.xlsx --reviewer jsmith --rubric-version v1 --write-db',
      'npx tsx apps/pipeline/src/commands/eval-review-import.ts --set <id> --from reviewer.xlsx --reviewer jsmith --rubric-version v1 --policy-labels --write-db',
      'npx tsx apps/pipeline/src/commands/eval-review-import.ts --set <id> --from .private/eval/references/unit-1-transcription-reference --reviewer jsmith --rubric-version v1 --write-db',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

interface PlannedWrite {
  itemId: string;
  reference: AuditReferenceRow | GradingReferenceRow | TranscriptionReferenceRow['reference'];
  reviewedBy: string;
}

/** Reads a transcription reference directory's `<slide>.md` files into a slide → content map, ignoring
 * anything else in the directory (README.md, dotfiles, stray files). */
function readTranscriptionReferenceDir(dir: string): Map<number, string> {
  const fileContentBySlide = new Map<number, string>();
  for (const fileName of readdirSync(dir)) {
    const match = fileName.match(/^(\d+)\.md$/);
    if (!match) continue;
    fileContentBySlide.set(Number(match[1]), readFileSync(join(dir, fileName), 'utf-8'));
  }
  return fileContentBySlide;
}

/**
 * `store` and `argv` are injection points for tests (a fake `EvalStore`) so validation refusals and
 * the write path are testable without a live Supabase connection. Production use (`runIfMain` below)
 * supplies neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  // eval_items is service-role only, read or write. Real Supabase access is skipped entirely when a
  // store is injected, so a test never needs live credentials or a network connection.
  const store = deps.store ?? createSupabaseEvalStore(createScriptSupabase({ write: true }));

  const set = await store.getSet(options.set);
  if (!set) {
    logger.error(`No eval set found with id ${options.set}`);
    process.exit(1);
  }
  if (set.task !== 'audit' && set.task !== 'grading' && set.task !== 'transcription') {
    logger.error(`eval-review-import supports 'audit', 'grading', and 'transcription' tasks only (got '${set.task}').`);
    process.exit(1);
  }
  if (options.policyLabels && set.task !== 'grading') {
    logger.error('--policy-labels only applies to the grading task.');
    process.exit(1);
  }

  let calibrationResult: Record<string, unknown> | null = null;
  if (options.calibrationResult) {
    try {
      calibrationResult = JSON.parse(options.calibrationResult) as Record<string, unknown>;
    } catch {
      logger.error(`--calibration-result is not valid JSON: ${options.calibrationResult}`);
      process.exit(1);
    }
  }

  const items = await store.listItems(options.set);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const knownItemIds = new Set(items.map((i) => i.id));

  let errors: ValidationError[];
  let rows: { itemId: string; reference: AuditReferenceRow | GradingReferenceRow | TranscriptionReferenceRow['reference'] }[];

  if (set.task === 'transcription') {
    const fileContentBySlide = readTranscriptionReferenceDir(options.from);
    ({ errors, rows } = validateTranscriptionReferenceFiles(items, fileContentBySlide));
  } else {
    const isXlsx = extname(options.from).toLowerCase() === '.xlsx';
    const sheetRows = isXlsx
      ? await readXlsxRows(options.from, options.sheet)
      : csvRowsToObjects(parseCsv(readFileSync(options.from, 'utf-8')));
    const dataRows = sheetRows.filter((row) => !isDescriptionRow(row));
    ({ errors, rows } = set.task === 'audit'
      ? validateAuditRows(dataRows, knownItemIds)
      : validateGradingRows(dataRows, knownItemIds));
  }

  if (errors.length > 0) {
    logger.error(`${errors.length} validation error(s) — nothing written:`);
    for (const e of errors) logger.error(`  ${e.itemId}: ${e.message}`);
    process.exit(1);
  }

  const writes: PlannedWrite[] = [];
  const skippedApproved: string[] = [];

  for (const row of rows) {
    const item = itemsById.get(row.itemId)!;
    if (item.reference_status === 'approved' && !options.overwrite) {
      skippedApproved.push(row.itemId);
      continue;
    }
    writes.push({ itemId: row.itemId, reference: row.reference, reviewedBy: options.reviewer });
  }

  if (options.policyLabels) {
    for (const item of items) {
      if (!(POLICY_LABEL_CLASSES as readonly string[]).includes(seededLabelClass(item) as GradingLabelClass)) continue;
      if (item.reference_status === 'approved' && !options.overwrite) {
        skippedApproved.push(item.id);
        continue;
      }
      writes.push({
        itemId: item.id,
        // Policy items are never reviewed, so the key is assumed correct.
        reference: { isCorrect: true, borderline: false, reason: POLICY_REASON, keyCorrect: true, keyNote: null },
        reviewedBy: 'policy',
      });
    }
  }

  const sourceLabel = set.task === 'transcription' ? 'the reference directory' : 'the sheet';
  console.log(
    `${writes.length} item(s) to write (${rows.length} from ${sourceLabel}${options.policyLabels ? ', plus policy-labelled items' : ''}), `
    + `${skippedApproved.length} already approved and skipped (pass --overwrite to replace them).`,
  );

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this reference.');
    return;
  }

  let written = 0;
  for (const w of writes) {
    try {
      await store.updateItem(w.itemId, {
        reference: w.reference as unknown as Record<string, unknown>,
        reference_status: 'approved',
        reviewed_by: w.reviewedBy,
        reviewed_at: new Date().toISOString(),
      });
      written++;
    } catch (err) {
      logger.error(`Failed to write reference for item ${w.itemId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Wrote reference for ${written} of ${writes.length} item(s).`);

  // Records what this completed import actually did, not what it attempted — reviewed_item_count
  // reflects successful writes only, so a partial failure above is reflected here rather than papered over.
  const reviewRound: NewEvalReviewRoundRow = {
    set_id: options.set,
    reviewer: options.reviewer,
    rubric_version: options.rubricVersion,
    rubric_hash: options.rubricHash ?? null,
    calibration_result: calibrationResult,
    reviewed_item_count: written,
  };
  await store.insertReviewRound(reviewRound);
}

runIfMain(import.meta.url, main);
