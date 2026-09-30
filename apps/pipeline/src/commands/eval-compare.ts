/**
 * Paired comparison of one or more candidate runs against a baseline run on their shared,
 * reference-approved items: agreement, McNemar's exact test, a 95% CI on the
 * difference, and the non-inferiority verdict against the task's tolerance. Also reports the
 * noise floor from repeats of the same variant among the runs given, and writes a markdown report.
 * Dry run by default (the report only); --write-db additionally updates each run's own
 * `eval_runs.summary.compare` with its part of the result. This is evidence, not a decision:
 * `--write-db` alone never touches `eval_findings` or an experiment's status — see `--decide` below.
 *
 * When the eval set has no approved reference, there is no accuracy verdict to compute — the command
 * falls back to a reference-free report instead of exiting: item-level agreement between runs, per-
 * criterion flip counts and flag rates (audit), cost and latency, and the noise floor from repeats,
 * labelled by whether the repeats shared identical audit groupings, since regrouping alone moves
 * audit verdicts. For audit runs, both reports also list every item where the compared runs
 * disagree, with each run's per-criterion verdict and notes, so a human can adjudicate.
 *
 * Grading only: a question whose answer key the reviewer marked Incorrect (`reference.keyCorrect ===
 * false`) is listed in the report and excluded from the accuracy figures by default, since the
 * model was scored against a key the reviewer says was wrong — pass --include-rejected-keys to
 * include those items instead.
 *
 * `--decide <adopt|reject|defer> --statement "<text>"` is the separate, explicit act of recording a
 * decision: it requires `--write-db`, a `--statement`, and the chosen candidate run to carry an
 * `experiment_id` (an ad hoc run — no `--experiment` at `eval-run` time — produces evidence, not a
 * decision). With more than one candidate in `--runs`, `--candidate <run_id>` says which one the
 * decision is about. `--decide adopt` additionally requires that candidate's comparison to have
 * produced a non-inferior verdict against a reference — refused on a reference-free comparison or a
 * verdict that isn't non-inferior; `reject` and `defer` need no verdict at all, since either can be a
 * judgment call the numbers don't settle. Recording a decision writes one `eval_findings` row citing
 * both compared run ids and moves the experiment to `decided` (adopt/reject) or `deferred` (defer).
 * A second decision citing the same baseline/candidate pair under the same experiment is refused
 * unless `--supersedes <finding_id>` names the earlier one — `eval_findings` is append-only, so a
 * changed mind is a new row pointing at the old one, never an edit.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { loadEnv } from '../lib/env';
import { createScriptSupabase } from '../lib/db-queries';
import { createSupabaseEvalStore, type EvalStore, type EvalResultRow, type EvalRunRow } from '../lib/eval/db';
import {
  extractAuditPairedOutcomes,
  extractGradingPairedOutcomes,
  findRejectedKeyQuestions,
  extractItemVerdictPairedOutcomes,
  buildAuditOutcomesForRun,
  auditPerCriterionVerdict,
  auditCriterionFlips,
  auditFlagRates,
  groupingComparisonFor,
  findAuditDisagreements,
  buildCompareMarkdown,
  buildReferenceFreeCompareMarkdown,
  type VariantComparison,
  type NoiseFloor,
  type ReferenceFreeVariantComparison,
  type ReferenceFreeNoiseFloor,
  type RejectedKeysReport,
} from '../lib/eval/compare/audit-grading';
import {
  extractMappingPairedOutcomes,
  mappingRunStats,
  buildMappingCompareMarkdown,
  type MappingVariantComparison,
  type MappingNoiseFloorEntry,
} from '../lib/eval/compare/mapping';
import {
  extractTranscriptionPairedOutcomes,
  extractTranscriptionAgreementScores,
  transcriptionRunStats,
  transcriptionNoContentAgreementVsReference,
  transcriptionNoContentAgreementBetweenRuns,
  transcriptionTableAgreementVsReference,
  pairedTranscriptionComparison,
  transcriptionNonInferiorityVerdict,
  buildTranscriptionCompareMarkdown,
  buildTranscriptionReferenceFreeCompareMarkdown,
  type TranscriptionVariantComparison,
  type TranscriptionNoiseFloorEntry,
  type TranscriptionReferenceFreeVariantComparison,
} from '../lib/eval/compare/transcription';
import { runCostLatency, providerPinMismatches } from '../lib/eval/compare/shared';
import { pairedComparison, pairedMappingComparison, mappingNoiseFloor, nonInferiorityVerdict, meanAndCi95 } from '../lib/eval/scoring';
import type { AuditGateCriterion, GradingReference } from '../lib/eval/runner';
import type { EvalTask } from '../lib/eval/types';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { EVAL_REPORTS_DIR, guardTrackedTreeWrite } from '../lib/eval/paths';
import { ensureDirFor } from '../lib/fs-utils';
import { runIfMain } from '../lib/run-if-main';
import { scoreTranscription } from '../lib/eval/transcription-scoring';

const logger = createLogger('eval-compare');

/**
 * Warns about any run in `runs` whose results named a served_provider other than the run's own
 * provider_pin — the pin is a request, not a guarantee that OpenRouter honored it.
 */
function warnProviderPinMismatches(runs: EvalRunRow[], resultsByRunId: Map<string, EvalResultRow[]>): void {
  for (const run of runs) {
    const mismatches = providerPinMismatches(run, resultsByRunId.get(run.id) ?? []);
    if (mismatches.length > 0) {
      logger.warn(`Run ${run.id} (${run.model}) pinned provider '${run.provider_pin}' but results were served by: ${mismatches.join(', ')}.`);
    }
  }
}

const DECIDE_KINDS = ['adopt', 'reject', 'defer'] as const;
type DecideKind = (typeof DECIDE_KINDS)[number];

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...loggingFlags,
    runs: { type: 'string', required: true, help: 'Comma-separated eval_runs ids to compare (baseline is added automatically if omitted)' },
    baseline: { type: 'string', required: true, help: 'eval_runs id to treat as the baseline variant' },
    out: { type: 'string', help: 'Markdown report path (default: .private/eval/reports/eval-compare-<timestamp>.md, or $EVAL_REPORTS_DIR if set)' },
    'include-rejected-keys': {
      type: 'boolean',
      default: false,
      help: 'Grading task: include items whose question key the reviewer marked Incorrect in the accuracy figures (excluded by default)',
    },
    decide: {
      type: 'string',
      choices: DECIDE_KINDS,
      help: "Records this comparison's decision as an eval_findings row and moves the candidate's experiment to decided (adopt/reject) or deferred (defer). Requires --write-db and --statement; 'adopt' additionally requires a non-inferior verdict against a reference.",
    },
    statement: { type: 'string', help: 'One-line human-readable statement for the eval_findings row (required with --decide)' },
    candidate: { type: 'string', help: 'Which of --runs the decision is about (required with --decide when --runs names more than one candidate)' },
    supersedes: { type: 'string', help: 'eval_findings id this decision supersedes — required to re-decide a baseline/candidate pair an experiment already has a finding for' },
  },
  {
    name: 'eval-compare',
    description: "Paired comparison of candidate runs against a baseline run, with the non-inferiority verdict and noise floor from any repeats. Falls back to a reference-free stability/agreement report when the set has no approved reference. Dry run by default (report only); --write-db also persists the result into each run's summary. --decide separately records the comparison's decision as an eval_findings row and updates the candidate's experiment status.",
    examples: [
      'npx tsx apps/pipeline/src/commands/eval-compare.ts --runs run-baseline,run-candidate --baseline run-baseline',
      'npx tsx apps/pipeline/src/commands/eval-compare.ts --runs run-a,run-b,run-c --baseline run-a --out .private/eval/reports/baseline-vs-candidate.md --write-db',
      'npx tsx apps/pipeline/src/commands/eval-compare.ts --runs run-baseline,run-candidate --baseline run-baseline --write-db --decide adopt --statement "Sonnet 5 matches baseline recall within tolerance; adopting for audit."',
    ],
  },
);

/** A candidate's non-inferiority verdict, as computed by whichever task-specific compare
 * function ran — undefined when the task/comparison has none (mapping, or any reference-free
 * comparison), which `--decide adopt`'s refusal below treats the same as a verdict that failed. */
interface CandidateVerdict {
  nonInferior: boolean;
  reason: string;
}

/** What a task-specific compare function hands back to `main`: the report, whether the
 * comparison was reference-free (no accuracy verdict of any kind was possible), and each candidate's
 * verdict where one was computed — the two pieces of context `--decide` needs beyond the report. */
interface CompareOutcome {
  markdown: string;
  referenceFree: boolean;
  verdictByCandidateId: Map<string, CandidateVerdict>;
}

type ItemReference = Map<string, Partial<Record<AuditGateCriterion, boolean>> | GradingReference>;

function pairedOutcomesFor(task: EvalTask, itemReference: ItemReference, a: EvalResultRow[], b: EvalResultRow[]) {
  return task === 'audit'
    ? extractAuditPairedOutcomes(itemReference as Map<string, Partial<Record<AuditGateCriterion, boolean>>>, a, b)
    : extractGradingPairedOutcomes(itemReference as Map<string, GradingReference>, a, b);
}

/** Runs sharing a model, sorted by repeat_index — the pairing `eval-run --repeat` produces. */
function repeatPairsByModel(runs: EvalRunRow[]): [EvalRunRow, EvalRunRow][] {
  const runsByModel = new Map<string, EvalRunRow[]>();
  for (const r of runs) {
    const group = runsByModel.get(r.model) ?? [];
    group.push(r);
    runsByModel.set(r.model, group);
  }
  const pairs: [EvalRunRow, EvalRunRow][] = [];
  for (const group of runsByModel.values()) {
    if (group.length < 2) continue;
    const [runA, runB] = [...group].sort((a, b) => a.repeat_index - b.repeat_index);
    pairs.push([runA, runB]);
  }
  return pairs;
}

/**
 * The per-task pieces `runTaskCompare` needs, everything else about comparing a baseline against
 * one or more candidates and reporting the result being identical across tasks. `TVariant` is the
 * task's own variant-comparison row shape (always carrying `candidateRunId`/`candidateModel`);
 * `TNoiseFloor` is its noise-floor row shape.
 */
interface RunTaskCompareParams<TVariant extends { candidateRunId: string; candidateModel: string }, TNoiseFloor> {
  store: ReturnType<typeof createSupabaseEvalStore>;
  baselineRun: EvalRunRow;
  candidateRuns: EvalRunRow[];
  runs: EvalRunRow[];
  resultsByRunId: Map<string, EvalResultRow[]>;
  writeDb: boolean;
  /** Whether this comparison has no accuracy verdict of any kind (no approved reference) — carried
   * through to `CompareOutcome` for `--decide adopt`'s refusal. */
  referenceFree: boolean;
  /** What the "no paired X between baseline and candidate" skip-warning calls X (e.g.
   * "reference-backed items", "scored items"). */
  noPairLabel: string;
  /** Builds one candidate's comparison row against the baseline, or `undefined` when the two share
   * no paired data (logged and skipped) — together with that candidate's non-inferiority verdict,
   * when this task/comparison computes one. */
  buildVariant: (candidate: EvalRunRow, baselineResults: EvalResultRow[], candidateResults: EvalResultRow[]) => { variant: TVariant; verdict?: CandidateVerdict } | undefined;
  /** Builds one repeat pair's noise-floor row, or `undefined` when the pair shares no overlap. */
  buildNoiseFloorEntry: (runA: EvalRunRow, runB: EvalRunRow) => TNoiseFloor | undefined;
  buildMarkdown: (variants: TVariant[], noiseFloors: TNoiseFloor[]) => string;
  /** The `eval_runs.summary.compare` object `--write-db` writes for one candidate, and for the
   * baseline (given every candidate's own comparison row). */
  candidateSummary: (variant: TVariant) => Record<string, unknown>;
  baselineSummary: (variants: TVariant[]) => Record<string, unknown>;
}

/**
 * Runs one task's comparison: pairs each candidate against the baseline, pairs any repeats of the
 * same variant for the noise floor, renders the report, and (with `--write-db`) persists each run's
 * part of the result into its own `eval_runs.summary.compare`. Every task's own comparison logic,
 * report shape, and summary shape come in through `params`; this function only owns the shared
 * shape — loop, skip-and-warn, render, and write.
 */
async function runTaskCompare<TVariant extends { candidateRunId: string; candidateModel: string }, TNoiseFloor>(
  params: RunTaskCompareParams<TVariant, TNoiseFloor>,
): Promise<CompareOutcome> {
  const { store, baselineRun, candidateRuns, runs, resultsByRunId, writeDb, referenceFree, noPairLabel, buildVariant, buildNoiseFloorEntry, buildMarkdown, candidateSummary, baselineSummary } = params;
  const baselineResults = resultsByRunId.get(baselineRun.id)!;

  const variants: TVariant[] = [];
  const verdictByCandidateId = new Map<string, CandidateVerdict>();
  for (const candidate of candidateRuns) {
    const candidateResults = resultsByRunId.get(candidate.id)!;
    const built = buildVariant(candidate, baselineResults, candidateResults);
    if (!built) {
      logger.warn(`No paired ${noPairLabel} between baseline (${baselineRun.id}) and ${candidate.model} (${candidate.id}) — skipping.`);
      continue;
    }
    variants.push(built.variant);
    if (built.verdict) verdictByCandidateId.set(candidate.id, built.verdict);
  }

  const noiseFloors: TNoiseFloor[] = [];
  for (const [runA, runB] of repeatPairsByModel(runs)) {
    const entry = buildNoiseFloorEntry(runA, runB);
    if (entry) noiseFloors.push(entry);
  }

  const markdown = buildMarkdown(variants, noiseFloors);

  if (writeDb) {
    for (const variant of variants) {
      const candidateRun = candidateRuns.find((r) => r.id === variant.candidateRunId)!;
      await store.updateRun(candidateRun.id, { summary: { ...(candidateRun.summary ?? {}), compare: candidateSummary(variant) } });
    }
    await store.updateRun(baselineRun.id, { summary: { ...(baselineRun.summary ?? {}), compare: baselineSummary(variants) } });
  }

  return { markdown, referenceFree, verdictByCandidateId };
}

/** Recomputes each stored transcript's score against the current reference, so a run made before
 * its slides were checked (its stored score is null) is scored like any other, and a corrected
 * reference rescores history without re-running anything. */
function rescoreTranscriptionResults(resultsByRunId: Map<string, EvalResultRow[]>, referenceMarkdownByItemId: Map<string, string>): Map<string, EvalResultRow[]> {
  const rescored = new Map<string, EvalResultRow[]>();
  for (const [runId, rows] of resultsByRunId) {
    rescored.set(runId, rows.map((r) => {
      const reference = referenceMarkdownByItemId.get(r.item_id);
      const markdown = (r.output as { markdown?: unknown } | null)?.markdown;
      return reference !== undefined && typeof markdown === 'string' ? { ...r, score: scoreTranscription(reference, markdown) } : r;
    }));
  }
  return rescored;
}

/**
 * `store` is an injection point for tests (a fake `EvalStore`) so `--decide`'s refusals and happy
 * paths are testable without a live Supabase connection. Production use (`runIfMain` below) supplies
 * neither, so both default to the real thing.
 */
export async function main(deps: { argv?: string[]; store?: EvalStore } = {}) {
  loadEnv();
  const options = cli.parse(deps.argv);
  setLogLevel(levelFromFlags(options));

  // Flag-shape validation happens before any DB lookup, so a malformed --decide invocation never
  // even looks up the runs.
  if (options.decide) {
    if (!options.writeDb) {
      logger.error('--decide requires --write-db — recording a decision is a database write, not a report-only dry run.');
      process.exit(1);
    }
    if (!options.statement) {
      logger.error('--decide requires --statement "<one line>" — the human-readable record of why.');
      process.exit(1);
    }
  }

  // eval_* tables are service-role only. Real Supabase access is skipped entirely when a store is
  // injected, so a test never needs live credentials or a network connection.
  const supabase = deps.store ? undefined : createScriptSupabase({ write: true });
  const store = deps.store ?? createSupabaseEvalStore(supabase!);

  const runIds = [...new Set([...options.runs.split(',').map((s) => s.trim()).filter(Boolean), options.baseline])];
  const fetchedRuns = await Promise.all(runIds.map((id) => store.getRun(id)));

  const missing = runIds.filter((id, i) => !fetchedRuns[i]);
  if (missing.length > 0) {
    logger.error(`No eval_runs row found for: ${missing.join(', ')}`);
    process.exit(1);
  }
  const runs = fetchedRuns as EvalRunRow[];

  const baselineRun = runs.find((r) => r.id === options.baseline)!;
  const candidateRuns = runs.filter((r) => r.id !== options.baseline);
  if (candidateRuns.length === 0) {
    logger.error('--runs must include at least one run other than --baseline');
    process.exit(1);
  }

  // Resolved up front so a malformed --decide invocation (ambiguous candidate, no experiment_id)
  // refuses before spending time on the comparison itself.
  let decideCandidateRun: EvalRunRow | undefined;
  if (options.decide) {
    if (candidateRuns.length > 1) {
      if (!options.candidate) {
        logger.error('--decide with more than one candidate in --runs requires --candidate <run_id> to say which one the decision is about.');
        process.exit(1);
      }
      const found = candidateRuns.find((r) => r.id === options.candidate);
      if (!found) {
        logger.error(`--candidate ${options.candidate} is not among --runs' candidates (${candidateRuns.map((r) => r.id).join(', ')}).`);
        process.exit(1);
      }
      decideCandidateRun = found;
    } else {
      if (options.candidate && options.candidate !== candidateRuns[0].id) {
        logger.error(`--candidate ${options.candidate} does not match the only candidate in --runs (${candidateRuns[0].id}).`);
        process.exit(1);
      }
      decideCandidateRun = candidateRuns[0];
    }
    if (!decideCandidateRun.experiment_id) {
      logger.error(`Run ${decideCandidateRun.id} has no experiment_id — eval-run it with --experiment to attach it to one before deciding.`);
      process.exit(1);
    }
  }

  for (const r of runs) {
    if (r.set_id !== baselineRun.set_id) {
      logger.error(`Run ${r.id} is on set ${r.set_id}, not baseline's set ${baselineRun.set_id} — every run must share the same eval set.`);
      process.exit(1);
    }
    if (r.task !== baselineRun.task) {
      logger.error(`Run ${r.id} is task '${r.task}', not baseline's '${baselineRun.task}'.`);
      process.exit(1);
    }
  }
  const task = baselineRun.task;
  if (task !== 'audit' && task !== 'grading' && task !== 'mapping' && task !== 'transcription') {
    logger.error(`eval-compare supports 'audit', 'grading', 'mapping', and 'transcription' tasks only (got '${task}').`);
    process.exit(1);
  }

  const resultsByRunId = new Map<string, EvalResultRow[]>();
  for (const r of runs) {
    resultsByRunId.set(r.id, await store.listResults(r.id));
  }
  warnProviderPinMismatches(runs, resultsByRunId);

  let outcome: CompareOutcome;
  if (task === 'mapping') {
    // Mapping's reference is always approved at eval-set-create time — no reference-free fallback needed.
    const baselineStats = mappingRunStats(resultsByRunId.get(baselineRun.id)!);
    outcome = await runTaskCompare<MappingVariantComparison, MappingNoiseFloorEntry>({
      store, baselineRun, candidateRuns, runs, resultsByRunId, writeDb: options.writeDb,
      referenceFree: false,
      noPairLabel: 'scored items',
      buildVariant: (candidate, baselineResults, candidateResults) => {
        const outcomes = extractMappingPairedOutcomes(baselineResults, candidateResults);
        if (outcomes.length === 0) return undefined;
        return {
          variant: {
            candidateRunId: candidate.id,
            candidateModel: candidate.model,
            candidateStats: mappingRunStats(candidateResults),
            paired: pairedMappingComparison(outcomes),
          },
        };
      },
      buildNoiseFloorEntry: (runA, runB) => {
        const outcomes = extractMappingPairedOutcomes(resultsByRunId.get(runA.id)!, resultsByRunId.get(runB.id)!);
        if (outcomes.length === 0) return undefined;
        return {
          model: runA.model,
          runIds: [runA.id, runB.id],
          n: outcomes.length,
          meanAbsDiff: mappingNoiseFloor(outcomes.map((o) => ({ itemId: o.itemId, f1A: o.baselineF1, f1B: o.candidateF1 }))),
        };
      },
      buildMarkdown: (variants, noiseFloors) => buildMappingCompareMarkdown({
        setId: baselineRun.set_id, baselineRunId: baselineRun.id, baselineModel: baselineRun.model,
        baselineStats, variants, noiseFloors, generatedAt: new Date().toISOString(),
      }),
      candidateSummary: (variant) => ({ baselineRunId: baselineRun.id, stats: variant.candidateStats, paired: variant.paired }),
      baselineSummary: (variants) => ({ role: 'baseline', stats: baselineStats, comparedAgainst: variants.map((v) => v.candidateRunId) }),
    });
  } else if (task === 'transcription') {
    // Unlike mapping, transcription's reference is reviewed after the fact — a fresh set has no reference
    // until eval-review-export/eval-review-import has run.
    const items = await store.listItems(baselineRun.set_id);
    const approvedItems = items.filter((i) => i.reference_status === 'approved' && i.reference);
    console.log(`Set ${baselineRun.set_id}: ${approvedItems.length} of ${items.length} item(s) have approved reference.`);

    if (approvedItems.length === 0) {
      logger.warn(`Eval set ${baselineRun.set_id} has no approved reference items — reporting agreement with the baseline transcript only, no accuracy verdict.`);
      outcome = await runTaskCompare<TranscriptionReferenceFreeVariantComparison, never>({
        store, baselineRun, candidateRuns, runs, resultsByRunId, writeDb: options.writeDb,
        referenceFree: true,
        noPairLabel: 'items',
        buildVariant: (candidate, baselineResults, candidateResults) => {
          const scores = extractTranscriptionAgreementScores(baselineResults, candidateResults);
          if (scores.length === 0) return undefined;
          return {
            variant: {
              candidateRunId: candidate.id,
              candidateModel: candidate.model,
              agreement: meanAndCi95(scores)!,
              n: scores.length,
              noContentAgreement: transcriptionNoContentAgreementBetweenRuns(baselineResults, candidateResults),
              candidateCostLatency: runCostLatency(candidateResults),
            },
          };
        },
        // buildTranscriptionReferenceFreeCompareMarkdown has no noise-floor section.
        buildNoiseFloorEntry: () => undefined,
        buildMarkdown: (variants) => buildTranscriptionReferenceFreeCompareMarkdown({
          setId: baselineRun.set_id, baselineRunId: baselineRun.id, baselineModel: baselineRun.model,
          baselineCostLatency: runCostLatency(resultsByRunId.get(baselineRun.id)!), variants, generatedAt: new Date().toISOString(),
        }),
        candidateSummary: (variant) => ({ referenceFree: true, baselineRunId: baselineRun.id, agreement: variant.agreement, noContentAgreement: variant.noContentAgreement }),
        baselineSummary: (variants) => ({ referenceFree: true, role: 'baseline', comparedAgainst: variants.map((v) => v.candidateRunId) }),
      });
    } else {
      const referenceMarkdownByItemId = new Map(approvedItems.map((i) => [i.id, ((i.reference as { markdown?: string }).markdown) ?? '']));
      const rescoredResultsByRunId = rescoreTranscriptionResults(resultsByRunId, referenceMarkdownByItemId);
      const baselineResults = rescoredResultsByRunId.get(baselineRun.id)!;
      const baselineStats = transcriptionRunStats(baselineResults);
      const baselineNoContentAgreement = transcriptionNoContentAgreementVsReference(baselineResults, referenceMarkdownByItemId);
      const baselineTableAgreement = transcriptionTableAgreementVsReference(baselineResults, referenceMarkdownByItemId);

      outcome = await runTaskCompare<TranscriptionVariantComparison, TranscriptionNoiseFloorEntry>({
        store, baselineRun, candidateRuns, runs, resultsByRunId: rescoredResultsByRunId, writeDb: options.writeDb,
        referenceFree: false,
        noPairLabel: 'scored items',
        buildVariant: (candidate, baselineResults, candidateResults) => {
          const outcomes = extractTranscriptionPairedOutcomes(baselineResults, candidateResults);
          if (outcomes.length === 0) return undefined;
          const candidateStats = transcriptionRunStats(candidateResults);
          const noContentAgreement = transcriptionNoContentAgreementVsReference(candidateResults, referenceMarkdownByItemId);
          const verdict = transcriptionNonInferiorityVerdict(baselineStats, candidateStats, outcomes, noContentAgreement);
          return {
            variant: {
              candidateRunId: candidate.id,
              candidateModel: candidate.model,
              candidateStats,
              paired: pairedTranscriptionComparison(outcomes),
              noContentAgreement,
              tableAgreement: transcriptionTableAgreementVsReference(candidateResults, referenceMarkdownByItemId),
              verdict,
            },
            verdict,
          };
        },
        buildNoiseFloorEntry: (runA, runB) => {
          const outcomes = extractTranscriptionPairedOutcomes(rescoredResultsByRunId.get(runA.id)!, rescoredResultsByRunId.get(runB.id)!);
          if (outcomes.length === 0) return undefined;
          return {
            model: runA.model,
            runIds: [runA.id, runB.id],
            n: outcomes.length,
            meanAbsDiff: mappingNoiseFloor(outcomes.map((o) => ({ itemId: o.itemId, f1A: o.baselineScore, f1B: o.candidateScore }))),
          };
        },
        buildMarkdown: (variants, noiseFloors) => buildTranscriptionCompareMarkdown({
          setId: baselineRun.set_id, baselineRunId: baselineRun.id, baselineModel: baselineRun.model,
          baselineStats, baselineNoContentAgreement, baselineTableAgreement, variants, noiseFloors, generatedAt: new Date().toISOString(),
        }),
        candidateSummary: (variant) => ({
          baselineRunId: baselineRun.id, stats: variant.candidateStats, paired: variant.paired,
          noContentAgreement: variant.noContentAgreement, tableAgreement: variant.tableAgreement, verdict: variant.verdict,
        }),
        baselineSummary: (variants) => ({ role: 'baseline', stats: baselineStats, comparedAgainst: variants.map((v) => v.candidateRunId) }),
      });
    }
  } else {
    const items = await store.listItems(baselineRun.set_id);
    const approvedItems = items.filter((i) => i.reference_status === 'approved' && i.reference);
    console.log(`Set ${baselineRun.set_id}: ${approvedItems.length} of ${items.length} item(s) have approved reference.`);

    if (approvedItems.length === 0) {
      logger.warn(`Eval set ${baselineRun.set_id} has no approved reference items — reporting stability and agreement only, no accuracy verdict.`);
      outcome = await runTaskCompare<ReferenceFreeVariantComparison, ReferenceFreeNoiseFloor>({
        store, baselineRun, candidateRuns, runs, resultsByRunId, writeDb: options.writeDb,
        referenceFree: true,
        noPairLabel: 'items',
        buildVariant: (candidate, baselineResults, candidateResults) => {
          const outcomes = extractItemVerdictPairedOutcomes(task, baselineResults, candidateResults);
          if (outcomes.length === 0) return undefined;
          return {
            variant: {
              candidateRunId: candidate.id,
              candidateModel: candidate.model,
              itemVerdictAgreement: pairedComparison(outcomes),
              criterionFlips: task === 'audit' ? auditCriterionFlips(baselineResults, candidateResults) : undefined,
              candidateFlagRates: task === 'audit' ? auditFlagRates(candidateResults) : undefined,
              candidateCostLatency: runCostLatency(candidateResults),
              auditDisagreements: task === 'audit' ? findAuditDisagreements(baselineResults, candidateResults) : undefined,
            },
          };
        },
        buildNoiseFloorEntry: (runA, runB) => {
          const outcomes = extractItemVerdictPairedOutcomes(task, resultsByRunId.get(runA.id)!, resultsByRunId.get(runB.id)!);
          if (outcomes.length === 0) return undefined;
          return { model: runA.model, runIds: [runA.id, runB.id], comparison: pairedComparison(outcomes), grouping: groupingComparisonFor(runA, runB) };
        },
        buildMarkdown: (variants, noiseFloors) => buildReferenceFreeCompareMarkdown({
          task, setId: baselineRun.set_id, baselineRunId: baselineRun.id, baselineModel: baselineRun.model,
          baselineFlagRates: task === 'audit' ? auditFlagRates(resultsByRunId.get(baselineRun.id)!) : undefined,
          baselineCostLatency: runCostLatency(resultsByRunId.get(baselineRun.id)!),
          variants, noiseFloors, generatedAt: new Date().toISOString(),
        }),
        candidateSummary: (variant) => ({
          referenceFree: true, baselineRunId: baselineRun.id, itemVerdictAgreement: variant.itemVerdictAgreement,
          criterionFlips: variant.criterionFlips ?? null, candidateFlagRates: variant.candidateFlagRates ?? null,
        }),
        baselineSummary: (variants) => ({ referenceFree: true, role: 'baseline', comparedAgainst: variants.map((v) => v.candidateRunId) }),
      });
    } else {
      const rejectedKeyQuestions = task === 'grading' ? findRejectedKeyQuestions(approvedItems) : [];
      const rejectedItemIds = new Set(rejectedKeyQuestions.flatMap((q) => q.itemIds));
      if (rejectedKeyQuestions.length > 0) {
        console.log(
          `${rejectedKeyQuestions.length} question(s) (${rejectedItemIds.size} item(s)) have a key marked Incorrect by the reviewer` +
          `${options.includeRejectedKeys ? ', included in the accuracy figures (--include-rejected-keys)' : ', excluded from the accuracy figures below (pass --include-rejected-keys to include them)'}.`,
        );
      }
      const referenceItems = task === 'grading' && !options.includeRejectedKeys
        ? approvedItems.filter((i) => !rejectedItemIds.has(i.id))
        : approvedItems;

      const itemReference: ItemReference = new Map(
        referenceItems.map((i) => [
          i.id,
          task === 'audit'
            ? (i.reference as Partial<Record<AuditGateCriterion, boolean>>)
            : (i.reference as unknown as GradingReference),
        ]),
      );
      const rejectedKeys: RejectedKeysReport | undefined = task === 'grading'
        ? {
            questions: rejectedKeyQuestions,
            excludedItemCount: options.includeRejectedKeys ? 0 : rejectedItemIds.size,
            included: options.includeRejectedKeys,
          }
        : undefined;

      outcome = await runTaskCompare<VariantComparison, NoiseFloor>({
        store, baselineRun, candidateRuns, runs, resultsByRunId, writeDb: options.writeDb,
        referenceFree: false,
        noPairLabel: 'reference-backed items',
        buildVariant: (candidate, baselineResults, candidateResults) => {
          const outcomes = pairedOutcomesFor(task, itemReference, baselineResults, candidateResults);
          if (outcomes.length === 0) return undefined;
          const comparison = pairedComparison(outcomes);
          const auditPerCriterion = task === 'audit'
            ? auditPerCriterionVerdict(
                buildAuditOutcomesForRun(itemReference as Map<string, Partial<Record<AuditGateCriterion, boolean>>>, baselineResults),
                buildAuditOutcomesForRun(itemReference as Map<string, Partial<Record<AuditGateCriterion, boolean>>>, candidateResults),
              )
            : undefined;
          const verdict = nonInferiorityVerdict(task, comparison);
          // Audit's real decision is per-criterion (see the module doc comment); grading's pooled
          // verdict IS its real decision, since it has only one criterion.
          const candidateVerdict: CandidateVerdict = auditPerCriterion
            ? {
                nonInferior: auditPerCriterion.every((c) => c.pass),
                reason: `${auditPerCriterion.filter((c) => c.pass).length}/${auditPerCriterion.length} criteria within tolerance: ${auditPerCriterion.map((c) => `${c.criterion}=${c.pass ? 'pass' : 'fail'}`).join(', ')}`,
              }
            : { nonInferior: verdict.nonInferior, reason: verdict.reason };
          return {
            variant: {
              candidateRunId: candidate.id,
              candidateModel: candidate.model,
              comparison,
              verdict,
              auditPerCriterion,
              auditDisagreements: task === 'audit' ? findAuditDisagreements(baselineResults, candidateResults) : undefined,
            },
            verdict: candidateVerdict,
          };
        },
        buildNoiseFloorEntry: (runA, runB) => {
          const outcomes = pairedOutcomesFor(task, itemReference, resultsByRunId.get(runA.id)!, resultsByRunId.get(runB.id)!);
          if (outcomes.length === 0) return undefined;
          return { model: runA.model, runIds: [runA.id, runB.id], comparison: pairedComparison(outcomes) };
        },
        buildMarkdown: (variants, noiseFloors) => buildCompareMarkdown({
          task, setId: baselineRun.set_id, baselineRunId: baselineRun.id, baselineModel: baselineRun.model,
          variants, noiseFloors, generatedAt: new Date().toISOString(), rejectedKeys,
        }),
        candidateSummary: (variant) => (variant.auditPerCriterion
          ? {
              baselineRunId: baselineRun.id,
              pooled: { ...variant.comparison, note: 'Pooled over correlated (item, criterion) pairs across all six criteria; informational, not the headline verdict.' },
              auditPerCriterion: variant.auditPerCriterion,
            }
          : { baselineRunId: baselineRun.id, comparison: variant.comparison, verdict: variant.verdict }),
        baselineSummary: (variants) => ({ role: 'baseline', comparedAgainst: variants.map((v) => v.candidateRunId) }),
      });
    }
  }
  const markdown = outcome.markdown;

  console.log(markdown);

  const outPath = guardTrackedTreeWrite(options.out ?? join(EVAL_REPORTS_DIR, `eval-compare-${Date.now()}.md`));
  ensureDirFor(outPath);
  writeFileSync(outPath, markdown);
  console.log(`Written to ${outPath}`);

  if (!options.writeDb) {
    console.log('\nDry run — pass --write-db to persist this comparison into each run\'s summary.compare.');
  }

  if (options.decide && decideCandidateRun) {
    const experimentId = decideCandidateRun.experiment_id!;
    const verdict = outcome.verdictByCandidateId.get(decideCandidateRun.id);

    if (options.decide === 'adopt' && (outcome.referenceFree || !verdict?.nonInferior)) {
      const why = outcome.referenceFree
        ? 'this is a reference-free comparison (no accuracy verdict was computed against a reference)'
        : verdict
          ? `run ${decideCandidateRun.id}'s verdict is not non-inferior (${verdict.reason})`
          : `no non-inferiority verdict was computed for run ${decideCandidateRun.id} on this task`;
      logger.error(`--decide adopt refused: ${why}.`);
      process.exit(1);
    }

    const existingFindings = await store.listFindings(experimentId);
    const conflicting = existingFindings.filter((f) => f.run_ids.includes(baselineRun.id) && f.run_ids.includes(decideCandidateRun!.id));
    if (conflicting.length > 0 && !(options.supersedes && conflicting.some((f) => f.id === options.supersedes))) {
      logger.error(
        `Experiment ${experimentId} already has a finding citing baseline ${baselineRun.id} and candidate ${decideCandidateRun.id} `
        + `(${conflicting.map((f) => f.id).join(', ')}). Pass --supersedes <finding_id> naming one of them to record a new decision.`,
      );
      process.exit(1);
    }

    const finding = await store.insertFinding({
      experiment_id: experimentId,
      kind: options.decide,
      task,
      statement: options.statement!,
      evidence_note: verdict?.reason ?? null,
      run_ids: [baselineRun.id, decideCandidateRun.id],
      supersedes_finding_id: options.supersedes,
    });
    const newStatus = options.decide === 'defer' ? 'deferred' : 'decided';
    await store.updateExperiment(experimentId, { status: newStatus, decided_at: new Date().toISOString() });
    console.log(`Recorded ${options.decide} finding ${finding.id} for experiment ${experimentId} (status now ${newStatus}).`);
  }
}

runIfMain(import.meta.url, main);
