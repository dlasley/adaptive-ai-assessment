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
 * verdict onto both runs' `eval_results.judge_verdict`, keyed first by the other run's id and then by
 * the judge prompt hash that produced it ({ [otherRunId]: { [judgePromptHash]: [entry, ...] } }).
 * Every run appends one entry to that list, so the same pairing judged again under the same prompt,
 * by the same or a different judge model, keeps every earlier entry; each entry carries a `repeat`
 * index (how many entries from the same judge model came before it), the call settings the command
 * sent, and the response facts of both position-order calls. Also stamps both runs'
 * `judge_model`/`judge_prompt_hash` with the model and hash used this time: those two columns
 * describe the latest judge call on the run, not any one pairing.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalItemRow, type EvalResultRow } from '../lib/eval/db';
import { renderSlideImage } from '../lib/pdf-conversion';
import { withRateLimitRetry } from '../lib/eval/run-loop';
import { MODEL_CALL_RETRY, isEmptyContentError } from '../lib/eval/tasks/shared';
import { BUDGET_CAPS_USD, isWithinBudget, projectCostUsd, registryPriceOf } from '../lib/eval/tolerances';
import {
  JUDGE_PROMPT_HASH,
  combineJudgeOrders,
  nextJudgeRepeat,
  parseJudgeVerdict,
  buildJudgeMessageContent,
  type JudgeCallMeta,
  type JudgeCallSettings,
  type JudgeVerdict,
  type JudgeVerdictEntry,
} from '../lib/eval/judge';
import { callLlm, responseMetaFromLlmResult, type LlmCallOptions } from '@adaptive/shared/llm';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';
import { resultByItem } from '../lib/eval/compare/shared';

const logger = createLogger('eval-judge');

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
    description: "Paired, position-swapped judge comparison of two completed transcription runs on their shared items, scored by a third model against the slide image directly rather than through a seeded reference. Dry run by default; --write-db calls the judge and appends an entry to eval_results.judge_verdict. Each run adds an entry, so a pair can be judged repeatedly and by several judge models. The runs' judge_model and judge_prompt_hash columns describe the latest judge call on the run.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-judge.ts --runs run-a,run-b --judge-model google/gemini-3.1-flash-lite',
      'npx tsx apps/pipeline/src/commands/eval-judge.ts --runs run-a,run-b --judge-model google/gemini-3.1-flash-lite --provider google-ai-studio --write-db',
    ],
  },
);

type Options = ReturnType<typeof cli.parse>;

/** A judge call is a single short classification; reasoning tokens would only spend budget without
 * changing the JSON contract it has to produce. */
const JUDGE_REASONING = { enabled: false } as const;

/** The entries already stored on one result row for a pairing under the current judge prompt hash.
 * A value that is not a list is a single-object entry from an earlier storage shape that has not been
 * converted to a one-element list; writing over it would drop it, so it is refused. */
function entriesUnderCurrentHash(result: EvalResultRow, otherRunId: string): JudgeVerdictEntry[] {
  const stored = (result.judge_verdict as Record<string, Record<string, unknown>> | null)?.[otherRunId]?.[JUDGE_PROMPT_HASH];
  if (stored === undefined) return [];
  if (!Array.isArray(stored)) {
    throw new Error(`Result ${result.id} holds a judge_verdict entry for run ${otherRunId} that is not a list: it is a single-object entry from an earlier storage shape and must be converted to a one-element list before judging again.`);
  }
  return stored as JudgeVerdictEntry[];
}

/** Says how many entries the pairing already holds under the current hash, per judge model, and
 * which repeat index this run takes for `judgeModel`. */
function describeExistingEntries(entryListsPerItem: JudgeVerdictEntry[][], judgeModel: string): string {
  const byModel = new Map<string, Map<number, number>>();
  for (const entries of entryListsPerItem) {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.judge_model, (counts.get(entry.judge_model) ?? 0) + 1);
    for (const [model, count] of counts) {
      const histogram = byModel.get(model) ?? new Map<number, number>();
      histogram.set(count, (histogram.get(count) ?? 0) + 1);
      byModel.set(model, histogram);
    }
  }
  const total = entryListsPerItem.length;
  const lines = [`Existing judge entries for this pairing under judge prompt hash ${JUDGE_PROMPT_HASH}:`];
  if (byModel.size === 0) lines.push('  none');
  for (const [model, histogram] of byModel) {
    const parts = [...histogram].sort((x, y) => x[0] - y[0]).map(([count, items]) => `${count} entr${count === 1 ? 'y' : 'ies'} on ${items} of ${total} item(s)`);
    lines.push(`  ${model}: ${parts.join(', ')}`);
  }
  const repeats = new Map<number, number>();
  for (const entries of entryListsPerItem) {
    const repeat = nextJudgeRepeat(entries, judgeModel);
    repeats.set(repeat, (repeats.get(repeat) ?? 0) + 1);
  }
  const repeatParts = [...repeats].sort((x, y) => x[0] - y[0]).map(([repeat, items]) => `repeat ${repeat} on ${items} item(s)`);
  lines.push(`This run (${judgeModel}) takes ${repeatParts.join(', ')}.`);
  return lines.join('\n');
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

  let existingByItem: Map<string, { forA: JudgeVerdictEntry[]; forB: JudgeVerdictEntry[] }>;
  try {
    existingByItem = new Map(sharedItems.map(({ item }) => [item.id, {
      forA: entriesUnderCurrentHash(byItemA.get(item.id)!, runB.id),
      forB: entriesUnderCurrentHash(byItemB.get(item.id)!, runA.id),
    }]));
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(describeExistingEntries(sharedItems.map(({ item }) => existingByItem.get(item.id)!.forA), options.judgeModel));

  if (!options.writeDb) {
    console.log('\nDry run. Pass --write-db to call the judge model and append a judge_verdict entry.');
    return;
  }

  if (!withinBudget) {
    logger.error(projected === undefined
      ? `${options.judgeModel} has no listed price, so the budget cap can't be enforced. Pass --allow-unpriced to run it anyway.`
      : `Projected cost ${projectedLabel} exceeds the $${cap} candidate budget cap.`);
    process.exit(1);
  }

  const providerPin: LlmCallOptions['provider'] = options.provider ? { order: [options.provider], allowFallbacks: false } : undefined;
  const judgeCall: JudgeCallSettings = { provider_pin: options.provider?.toLowerCase() ?? null, reasoning: JUDGE_REASONING, temperature: null };
  const judgedAt = new Date().toISOString();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-judge-slides-'));

  const wins = { a: 0, b: 0, tie: 0 };
  const nonTieItems: Array<{ itemKey: string; winnerRunId: string }> = [];
  let actualCostUsd = 0;
  const skipped: Array<{ itemKey: string; missingRepeat: number }> = [];

  try {
    for (const { item, markdownA, markdownB } of sharedItems) {
      const slide = item.payload.slide as number;
      const slideText = String(item.payload.text_layer ?? '');
      const imageBytes = renderSlideImage(pdfPath, slide, tmpDir);

      const judgeOnce = async (transcriptA: string, transcriptB: string): Promise<{ verdict: JudgeVerdict; meta: JudgeCallMeta }> => {
        const content = buildJudgeMessageContent(slideText, transcriptA, transcriptB, imageBytes);
        const result = await withRateLimitRetry(() => callLlmFn({
          model: options.judgeModel,
          jsonMode: true,
          // A judge call is a single short classification; reasoning tokens would only spend budget
          // without changing the JSON contract it has to produce.
          reasoning: judgeCall.reasoning,
          provider: providerPin,
          sessionId: `${runA.id}:${runB.id}`,
          messages: [{ role: 'user', content }],
        }), {
          ...MODEL_CALL_RETRY,
          onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) on item ${item.item_key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
        });
        actualCostUsd += result.usage?.costUsd ?? 0;
        const meta: JudgeCallMeta = { ...(responseMetaFromLlmResult(result) ?? {}) };
        if (result.servedModel !== undefined) meta.served_model = result.servedModel;
        if (result.servedProvider !== undefined) meta.served_provider = result.servedProvider;
        return { verdict: parseJudgeVerdict(result.text), meta };
      };

      let order1: { verdict: JudgeVerdict; meta: JudgeCallMeta };
      let order2: { verdict: JudgeVerdict; meta: JudgeCallMeta };
      try {
        order1 = await judgeOnce(markdownA, markdownB);
        order2 = await judgeOnce(markdownB, markdownA);
      } catch (err) {
        const reason = isEmptyContentError(err) ? 'empty content' : err instanceof Error ? err.message : String(err);
        logger.error(`Item ${item.item_key} failed to judge (${reason}), skipped.`);
        skipped.push({ itemKey: item.item_key, missingRepeat: nextJudgeRepeat(existingByItem.get(item.id)!.forA, options.judgeModel) });
        continue;
      }

      const outcome = combineJudgeOrders(order1.verdict, order2.verdict);
      wins[outcome]++;
      if (outcome !== 'tie') {
        nonTieItems.push({ itemKey: item.item_key, winnerRunId: outcome === 'a' ? runA.id : runB.id });
      }

      const outcomeForA = outcome === 'a' ? 'win' : outcome === 'b' ? 'loss' : 'tie';
      const outcomeForB = outcome === 'b' ? 'win' : outcome === 'a' ? 'loss' : 'tie';
      const reasons = [order1.verdict.reason, order2.verdict.reason];
      const calls = [order1.meta, order2.meta];
      const resultA = byItemA.get(item.id)!;
      const resultB = byItemB.get(item.id)!;
      // Each write re-reads the row so entries another eval-judge process stored in the meantime are kept.
      const appendEntry = async (resultId: string, otherRunId: string, outcomeForRun: JudgeVerdictEntry['outcome']) => {
        const fresh = await store.getResult(resultId);
        if (!fresh) throw new Error(`Result ${resultId} no longer exists.`);
        const column = (fresh.judge_verdict as Record<string, Record<string, unknown>> | null) ?? {};
        const prior = entriesUnderCurrentHash(fresh, otherRunId);
        const entry: JudgeVerdictEntry = {
          outcome: outcomeForRun,
          judge_model: options.judgeModel,
          repeat: nextJudgeRepeat(prior, options.judgeModel),
          reasons,
          judged_at: judgedAt,
          judge_call: judgeCall,
          calls,
        };
        await store.updateResultJudgeVerdict(resultId, {
          ...column,
          [otherRunId]: {
            ...(column[otherRunId] ?? {}),
            [JUDGE_PROMPT_HASH]: [...prior, entry],
          },
        });
      };

      await appendEntry(resultA.id, runB.id, outcomeForA);
      await appendEntry(resultB.id, runA.id, outcomeForB);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const judgedCount = wins.a + wins.b + wins.tie;
  if (judgedCount > 0) {
    await store.updateRun(runA.id, { judge_model: options.judgeModel, judge_prompt_hash: JUDGE_PROMPT_HASH });
    await store.updateRun(runB.id, { judge_model: options.judgeModel, judge_prompt_hash: JUDGE_PROMPT_HASH });
  }

  console.log('');
  console.log(`Items judged: ${judgedCount}`);
  console.log(`Wins for run ${runA.id}: ${wins.a}`);
  console.log(`Wins for run ${runB.id}: ${wins.b}`);
  console.log(`Ties: ${wins.tie}`);
  console.log(`Non-tie items: ${nonTieItems.length > 0 ? nonTieItems.map((i) => `${i.itemKey} (${i.winnerRunId})`).join(', ') : 'none'}`);
  console.log(`Projected judge cost: ${projectedLabel}`);
  console.log(`Actual judge cost: $${actualCostUsd.toFixed(4)}`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} item(s) after their judge calls failed: ${skipped.map((s) => `${s.itemKey} (missing repeat ${s.missingRepeat})`).join(', ')}.`);
    console.log(`These items hold one fewer entry than the rest for judge model ${options.judgeModel}.`);
  }
}

runIfMain(import.meta.url, main);
