/**
 * A third-vendor judge comparison of two completed transcription runs on their shared items. For
 * each slide both runs transcribed with usable output, the judge model looks at the slide image, the
 * PDF text-layer hint, and the two transcripts (labelled A and B), and picks the more complete and
 * faithful one. Every item is judged twice, with the two runs' positions swapped between the two
 * calls, so a run wins the item only when it wins in both orders — this cancels a judge's tendency
 * to favor whichever transcript it sees first.
 *
 * `eval-compare`'s accuracy figures score a run against a reference transcript, and for transcription
 * that reference was itself seeded from production's own model output — a run compared through it is
 * partly scored against that model's own choices. This command has no reference in the loop: the
 * judge only ever sees the slide and the two transcripts.
 *
 * Dry run by default, printing the projected judge cost; `--write-db` calls the judge and writes the
 * verdict onto both runs' `eval_results.judge_verdict` (merged, keyed by the other run's id, so a run
 * judged against several others accumulates one entry per comparison) and both runs' `judge_model`/
 * `judge_prompt_hash`.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalItemRow, type EvalResultRow } from '../lib/eval/db';
import { renderSlideImage } from '../lib/pdf-conversion';
import { withRateLimitRetry } from '../lib/eval/run-loop';
import { MODEL_CALL_RETRY, isEmptyContentError, hashText } from '../lib/eval/tasks/shared';
import { BUDGET_CAPS_USD, isWithinBudget, projectCostUsd, registryPriceOf } from '../lib/eval/tolerances';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { callLlm, type LlmCallOptions, type LlmContentPart } from '@adaptive/shared/llm';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { PROMPTS_DIR } from '../lib/paths';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('eval-judge');

export const JUDGE_PROMPT = renderCoursePrompt(
  fs.readFileSync(path.join(PROMPTS_DIR, 'eval-judge-transcription.md'), 'utf-8'),
);
/** sha256 (16 hex) of the rendered judge prompt, stamped onto both judged runs as judge_prompt_hash. */
export const JUDGE_PROMPT_HASH = hashText(JUDGE_PROMPT);

/**
 * Rough per-call token estimate: the judge prompt, one slide's text-layer hint and rendered image,
 * and two full transcripts to compare (each roughly the size of one transcription call's own
 * completion). Not yet checked against a real judge run's recorded usage. Completion is small — the
 * JSON verdict is one word plus a one-sentence reason.
 */
const JUDGE_PROMPT_TOKENS_PER_CALL = 8_000;
const JUDGE_COMPLETION_TOKENS_PER_CALL = 150;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    runs: { type: 'string', required: true, help: 'Comma-separated eval_runs ids to judge against each other (exactly two, both completed transcription runs on the same set)' },
    'judge-model': { type: 'string', required: true, help: 'OpenRouter model slug for the judge' },
    provider: { type: 'string', help: 'Provider tag to pin the judge call to (single upstream, fallbacks disabled)' },
    'allow-unpriced': { type: 'boolean', default: false, help: 'Call the judge model even when it has no listed price, so its cost cannot be projected or capped' },
  },
  {
    name: 'eval-judge',
    description: "Paired, position-swapped judge comparison of two completed transcription runs on their shared items, scored by a third model against the slide image directly rather than through a seeded reference. Dry run by default; --write-db calls the judge and writes eval_results.judge_verdict.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-judge.ts --runs run-a,run-b --judge-model google/gemini-3.1-flash-lite',
      'npx tsx apps/pipeline/src/commands/eval-judge.ts --runs run-a,run-b --judge-model google/gemini-3.1-flash-lite --provider google-ai-studio --write-db',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

export type JudgeWinner = 'A' | 'B' | 'tie';

export interface JudgeVerdict {
  winner: JudgeWinner;
  reason: string;
}

export class JudgeParseError extends Error {}

function validateJudgeVerdictShape(parsed: unknown): asserts parsed is JudgeVerdict {
  const p = parsed as Partial<JudgeVerdict> | null;
  if (!p || (p.winner !== 'A' && p.winner !== 'B' && p.winner !== 'tie') || typeof p.reason !== 'string' || p.reason.trim() === '') {
    throw new JudgeParseError('judge response missing a valid winner/reason');
  }
}

/** Strips markdown code fences (the prompt asks for none, but a model sometimes adds them anyway),
 * parses JSON, and validates the shape a caller depends on. Mirrors
 * `@adaptive/shared/grading-prompt`'s `parseEvaluationResponse`. */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new JudgeParseError('judge response was not valid JSON');
  }
  validateJudgeVerdictShape(parsed);
  return parsed;
}

export type ItemOutcome = 'a' | 'b' | 'tie';

/**
 * Combines the two position-swapped judge calls for one item into a single outcome. `order1` judged
 * run A in the A slot and run B in the B slot; `order2` swapped them, so a "B" verdict in `order2`
 * means run A won that call. A run wins the item only when it wins in both orders — a split decision,
 * or either order coming back a tie, is a tie. This cancels a judge's position bias: a judge that
 * always preferred whichever transcript came first would win run A once and run B once, which this
 * combines to a tie rather than crediting either run.
 */
export function combineJudgeOrders(order1: JudgeVerdict, order2: JudgeVerdict): ItemOutcome {
  const aWinsOrder1 = order1.winner === 'A';
  const bWinsOrder1 = order1.winner === 'B';
  const aWinsOrder2 = order2.winner === 'B';
  const bWinsOrder2 = order2.winner === 'A';
  if (aWinsOrder1 && aWinsOrder2) return 'a';
  if (bWinsOrder1 && bWinsOrder2) return 'b';
  return 'tie';
}

/** The exact per-call message content: the judge prompt plus a text-layer hint, the two transcripts
 * under comparison, and the rendered slide image. */
export function buildJudgeMessageContent(slideText: string, transcriptA: string, transcriptB: string, imageBytes: Buffer): LlmContentPart[] {
  const hint = slideText.trim().length > 0
    ? `\n\nText layer extracted from this slide by a PDF text extractor (may be incomplete or out of order — use it as a hint only):\n\n${slideText}`
    : '\n\nNo text layer was extracted from this slide (likely image-only).';
  const body = `${JUDGE_PROMPT}${hint}\n\n## Transcript A\n\n${transcriptA}\n\n## Transcript B\n\n${transcriptB}`;
  return [
    { type: 'text', text: body },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } },
  ];
}

function resultByItem(results: EvalResultRow[]): Map<string, EvalResultRow> {
  return new Map(results.map((r) => [r.item_id, r]));
}

/** The transcript text a result row carries, or undefined when the call errored or produced no
 * usable markdown — `eval-judge` only judges items where both runs have real output. */
function markdownOf(result: EvalResultRow | undefined): string | undefined {
  if (!result || result.error) return undefined;
  const markdown = (result.output as { markdown?: unknown } | null)?.markdown;
  return typeof markdown === 'string' ? markdown : undefined;
}

interface SharedItem {
  item: EvalItemRow;
  markdownA: string;
  markdownB: string;
}

/**
 * `store` and `callLlmFn` are injection points for tests (a fake `EvalStore`, a stubbed `callLlm`) so
 * validation, the position-swap combination, and the write path are testable without a live Supabase
 * connection or a real model call. Production use (`runIfMain` below) supplies neither, so both
 * default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore; callLlmFn?: typeof callLlm } = {}) {
  loadEnv();
  const options: Options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  const callLlmFn = deps.callLlmFn ?? callLlm;
  // eval_* tables are service-role only. Real Supabase access is skipped entirely when a store is
  // injected, so a test never needs live credentials or a network connection.
  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const runIds = [...new Set(options.runs.split(',').map((s) => s.trim()).filter(Boolean))];
  if (runIds.length !== 2) {
    logger.error(`--runs must name exactly two distinct eval_runs ids (got ${runIds.length}).`);
    process.exit(1);
  }

  const fetched = await Promise.all(runIds.map((id) => store.getRun(id)));
  const missing = runIds.filter((id, i) => !fetched[i]);
  if (missing.length > 0) {
    logger.error(`No eval_runs row found for: ${missing.join(', ')}`);
    process.exit(1);
  }
  const [runA, runB] = fetched as NonNullable<(typeof fetched)[number]>[];

  for (const run of [runA, runB]) {
    if (run.task !== 'transcription') {
      logger.error(`Run ${run.id} is task '${run.task}': eval-judge only supports 'transcription' runs.`);
      process.exit(1);
    }
  }
  if (runA.set_id !== runB.set_id) {
    logger.error(`Run ${runA.id} is on set ${runA.set_id}, run ${runB.id} is on set ${runB.set_id}, but both runs must share the same eval set.`);
    process.exit(1);
  }
  for (const run of [runA, runB]) {
    if (run.status !== 'completed') {
      logger.error(`Run ${run.id} has status '${run.status}', not 'completed'.`);
      process.exit(1);
    }
  }

  const set = await store.getSet(runA.set_id);
  if (!set) {
    logger.error(`No eval_sets row found for id ${runA.set_id}.`);
    process.exit(1);
  }
  const pdfPath = (set.selection as { pdfPath?: string }).pdfPath;
  if (!pdfPath) {
    logger.error(`Eval set ${runA.set_id} has no selection.pdfPath recorded, so it wasn't created with --task transcription.`);
    process.exit(1);
  }

  const items = await store.listItems(runA.set_id);
  const resultsA = await store.listResults(runA.id);
  const resultsB = await store.listResults(runB.id);
  const byItemA = resultByItem(resultsA);
  const byItemB = resultByItem(resultsB);

  const sharedItems: SharedItem[] = [];
  for (const item of items) {
    const markdownA = markdownOf(byItemA.get(item.id));
    const markdownB = markdownOf(byItemB.get(item.id));
    if (markdownA === undefined || markdownB === undefined) continue;
    sharedItems.push({ item, markdownA, markdownB });
  }
  console.log(`Set ${runA.set_id}: ${sharedItems.length} of ${items.length} item(s) have non-error output on both run ${runA.id} and run ${runB.id}.`);

  if (sharedItems.length === 0) {
    logger.warn('No shared items to judge.');
    return;
  }

  const judgeModelRow = await store.getModelBySlug(options.judgeModel);
  const price = registryPriceOf(judgeModelRow ?? undefined);
  const callCount = sharedItems.length * 2;
  const projected = projectCostUsd(price, callCount, JUDGE_PROMPT_TOKENS_PER_CALL, JUDGE_COMPLETION_TOKENS_PER_CALL);
  const cap = BUDGET_CAPS_USD.candidateRun;
  const withinBudget = isWithinBudget(projected, cap, options.allowUnpriced);
  const projectedLabel = projected !== undefined ? `$${projected.toFixed(4)}` : 'unknown (unpriced judge model)';
  console.log(`Judge ${options.judgeModel}: ${callCount} call(s) (two per item, positions swapped), projected ${projectedLabel} against a $${cap} cap.`);

  if (!options.writeDb) {
    console.log('\nDry run. Pass --write-db to call the judge model and write judge_verdict.');
    return;
  }

  if (!withinBudget) {
    logger.error(projected === undefined
      ? `${options.judgeModel} has no listed price, so the budget cap can't be enforced. Pass --allow-unpriced to run it anyway.`
      : `Projected cost ${projectedLabel} exceeds the $${cap} candidate budget cap.`);
    process.exit(1);
  }

  const providerPin: LlmCallOptions['provider'] = options.provider ? { order: [options.provider], allowFallbacks: false } : undefined;
  const judgedAt = new Date().toISOString();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-judge-slides-'));

  const wins = { a: 0, b: 0, tie: 0 };
  const nonTieItems: Array<{ itemKey: string; winnerRunId: string }> = [];
  let actualCostUsd = 0;

  try {
    for (const { item, markdownA, markdownB } of sharedItems) {
      const slide = item.payload.slide as number;
      const slideText = String(item.payload.text_layer ?? '');
      const imageBytes = renderSlideImage(pdfPath, slide, tmpDir);

      const judgeOnce = async (transcriptA: string, transcriptB: string): Promise<JudgeVerdict> => {
        const content = buildJudgeMessageContent(slideText, transcriptA, transcriptB, imageBytes);
        const result = await withRateLimitRetry(() => callLlmFn({
          model: options.judgeModel,
          jsonMode: true,
          // A judge call is a single short classification; reasoning tokens would only spend budget
          // without changing the JSON contract it has to produce.
          reasoning: { enabled: false },
          provider: providerPin,
          sessionId: `${runA.id}:${runB.id}`,
          messages: [{ role: 'user', content }],
        }), {
          ...MODEL_CALL_RETRY,
          onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) on item ${item.item_key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
        });
        actualCostUsd += result.usage?.costUsd ?? 0;
        return parseJudgeVerdict(result.text);
      };

      let order1: JudgeVerdict;
      let order2: JudgeVerdict;
      try {
        order1 = await judgeOnce(markdownA, markdownB);
        order2 = await judgeOnce(markdownB, markdownA);
      } catch (err) {
        const reason = isEmptyContentError(err) ? 'empty content' : err instanceof Error ? err.message : String(err);
        logger.error(`Item ${item.item_key} failed to judge (${reason}), skipped.`);
        continue;
      }

      const outcome = combineJudgeOrders(order1, order2);
      wins[outcome]++;
      if (outcome !== 'tie') {
        nonTieItems.push({ itemKey: item.item_key, winnerRunId: outcome === 'a' ? runA.id : runB.id });
      }

      const outcomeForA = outcome === 'a' ? 'win' : outcome === 'b' ? 'loss' : 'tie';
      const outcomeForB = outcome === 'b' ? 'win' : outcome === 'a' ? 'loss' : 'tie';
      const reasons = [order1.reason, order2.reason];
      const resultA = byItemA.get(item.id)!;
      const resultB = byItemB.get(item.id)!;

      await store.updateResultJudgeVerdict(resultA.id, {
        ...(resultA.judge_verdict ?? {}),
        [runB.id]: { outcome: outcomeForA, judge_model: options.judgeModel, reasons, judged_at: judgedAt },
      });
      await store.updateResultJudgeVerdict(resultB.id, {
        ...(resultB.judge_verdict ?? {}),
        [runA.id]: { outcome: outcomeForB, judge_model: options.judgeModel, reasons, judged_at: judgedAt },
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  await store.updateRun(runA.id, { judge_model: options.judgeModel, judge_prompt_hash: JUDGE_PROMPT_HASH });
  await store.updateRun(runB.id, { judge_model: options.judgeModel, judge_prompt_hash: JUDGE_PROMPT_HASH });

  const judgedCount = wins.a + wins.b + wins.tie;
  console.log('');
  console.log(`Items judged: ${judgedCount}`);
  console.log(`Wins for run ${runA.id}: ${wins.a}`);
  console.log(`Wins for run ${runB.id}: ${wins.b}`);
  console.log(`Ties: ${wins.tie}`);
  console.log(`Non-tie items: ${nonTieItems.length > 0 ? nonTieItems.map((i) => `${i.itemKey} (${i.winnerRunId})`).join(', ') : 'none'}`);
  console.log(`Projected judge cost: ${projectedLabel}`);
  console.log(`Actual judge cost: $${actualCostUsd.toFixed(4)}`);
}

runIfMain(import.meta.url, main);
