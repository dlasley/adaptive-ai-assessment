/**
 * Pure logic behind `eval-compare` for the audit and grading tasks: turns two runs' `eval_results`
 * into the paired agreement-with-reference outcomes `scoring.ts`'s `pairedComparison` needs, and
 * renders the finished comparison as a markdown report — reference-backed when the set has approved
 * reference items, reference-free (stability and agreement only) when it doesn't. No Supabase or
 * LLM calls here.
 *
 * Grading's headline is exact: false-negative rate is already single-valued, and the paired test
 * over it is a direct, correct measurement. Audit's real tolerance is six separate per-criterion
 * recall/precision numbers; `extractAuditPairedOutcomes`'s pooled McNemar test over every
 * "should flag" (item, criterion) pair, across all six criteria at once, is reported too but
 * labelled `pooled` throughout — pooling multiple, likely-correlated observations from the same
 * item (a question flagged on one criterion is more likely to be flagged on others) into what
 * McNemar's test treats as independent pairs is pseudo-replication, and generally makes the
 * p-value look smaller and the CI narrower than the independent information content actually
 * supports. The audit task's real non-inferiority headline comes from `auditPerCriterionVerdict`
 * instead: each criterion's own recall and precision, computed independently per variant (not
 * paired), checked against the task's tolerance.
 */

import {
  type PairedItemOutcome,
  type PairedComparisonResult,
  type NonInferiorityVerdict,
} from '../scoring';
import { resolveTolerance, type ResolvedTolerance } from '../tolerances';
import {
  expectedIsCorrect,
  criterionPrecisionRecallF1,
  isGatePass,
  AUDIT_GATE_CRITERIA,
  type AuditGateCriterion,
  type AuditItemOutcome,
  type GradingReference,
  type PrecisionRecallF1,
} from '../runner';
import type { EvalItemRow, EvalResultRow, EvalRunRow } from '../db';
import type { EvalTask } from '../types';
import { resultByItem, formatOrNA, buildNoiseFloorSection, type RunCostLatency } from './shared';

/**
 * Grading: restricted to items with approved reference where reference says the answer should be correct
 * (false negatives are only defined there) — pass=true means "this variant produced a false
 * negative on this item", matching `PairedItemOutcome`'s lower-is-better convention so the
 * resulting pass rate IS the false-negative rate.
 */
export function extractGradingPairedOutcomes(
  itemReference: Map<string, GradingReference>,
  baselineResults: EvalResultRow[],
  candidateResults: EvalResultRow[],
): PairedItemOutcome[] {
  const baselineByItem = resultByItem(baselineResults);
  const candidateByItem = resultByItem(candidateResults);
  const outcomes: PairedItemOutcome[] = [];

  for (const [itemId, reference] of itemReference) {
    const expectedCorrect = expectedIsCorrect(reference);
    if (!expectedCorrect) continue; // a false negative is only defined for expected-correct items

    const baseline = baselineByItem.get(itemId);
    const candidate = candidateByItem.get(itemId);
    const baselineOutput = baseline?.output as { isCorrect: boolean } | null | undefined;
    const candidateOutput = candidate?.output as { isCorrect: boolean } | null | undefined;
    if (!baselineOutput || !candidateOutput) continue; // one variant errored on this item — no pair

    outcomes.push({
      itemId,
      baselinePass: !baselineOutput.isCorrect, // true = false negative
      candidatePass: !candidateOutput.isCorrect,
    });
  }
  return outcomes;
}

export interface RejectedKeyQuestion {
  /** The item's own `payload.question_id` — the stable identifier for the source question. A
   * reviewer sheet's `Q1..Qn` labels are only assigned at export time and aren't persisted. */
  questionRef: string;
  /** The question text, truncated to 80 characters. */
  question: string;
  itemIds: string[];
}

/**
 * Groups approved grading items by their source question and returns every group whose reference marks
 * the answer key Incorrect (`keyCorrect === false`) — the same verdict is written to every item of
 * a group, so any one item's reference identifies the whole group.
 */
export function findRejectedKeyQuestions(items: EvalItemRow[]): RejectedKeyQuestion[] {
  const groups = new Map<string, EvalItemRow[]>();
  for (const item of items) {
    const questionRef = String(item.payload.question_id ?? item.id);
    const group = groups.get(questionRef);
    if (group) group.push(item);
    else groups.set(questionRef, [item]);
  }

  const rejected: RejectedKeyQuestion[] = [];
  for (const [questionRef, groupItems] of groups) {
    const reference = groupItems.find((i) => i.reference)?.reference as GradingReference | undefined;
    if (!reference || reference.keyCorrect !== false) continue;
    rejected.push({
      questionRef,
      question: String(groupItems[0].payload.question ?? '').slice(0, 80),
      itemIds: groupItems.map((i) => i.id),
    });
  }
  return rejected;
}

/**
 * Audit: one paired-outcome row per (item, criterion) pair where reference says that criterion should
 * flag (reference[criterion] === false) — pass=true means "this variant correctly flagged it" (recall
 * hit), a higher-is-better outcome, aggregated across all six criteria into one paired test.
 */
export function extractAuditPairedOutcomes(
  itemReference: Map<string, Partial<Record<AuditGateCriterion, boolean>>>,
  baselineResults: EvalResultRow[],
  candidateResults: EvalResultRow[],
): PairedItemOutcome[] {
  const baselineByItem = resultByItem(baselineResults);
  const candidateByItem = resultByItem(candidateResults);
  const outcomes: PairedItemOutcome[] = [];

  for (const [itemId, reference] of itemReference) {
    const baseline = baselineByItem.get(itemId);
    const candidate = candidateByItem.get(itemId);
    const baselineOutput = baseline?.output as Partial<Record<AuditGateCriterion, boolean>> | null | undefined;
    const candidateOutput = candidate?.output as Partial<Record<AuditGateCriterion, boolean>> | null | undefined;
    if (!baselineOutput || !candidateOutput) continue;

    for (const criterion of AUDIT_GATE_CRITERIA) {
      if (reference[criterion] !== false) continue; // reference doesn't say this criterion should flag
      outcomes.push({
        itemId: `${itemId}:${criterion}`,
        baselinePass: baselineOutput[criterion] === false,
        candidatePass: candidateOutput[criterion] === false,
      });
    }
  }
  return outcomes;
}

/** Builds the per-item outcomes `criterionPrecisionRecallF1` needs for one run, independently of
 * any other run — not a paired comparison, so this carries none of the pooled test's
 * pseudo-replication concern. */
export function buildAuditOutcomesForRun(
  itemReference: Map<string, Partial<Record<AuditGateCriterion, boolean>>>,
  results: EvalResultRow[],
): AuditItemOutcome[] {
  const resultByItemId = resultByItem(results);
  return [...itemReference.entries()].map(([itemId, reference]) => ({
    itemId,
    reference,
    output: (resultByItemId.get(itemId)?.output as Partial<Record<AuditGateCriterion, boolean>> | null) ?? undefined,
  }));
}

// ── Reference-free comparison ─────────────────────────────────────────────────────
//
// When an eval set has no approved reference, there is no ground truth to check either run against —
// only each run's own verdict, and whether two runs (or two repeats of the same variant) agree
// with each other. None of the functions below reference `reference`; the same pairing logic works for
// a candidate-vs-baseline comparison and for a noise-floor repeat comparison, since both are really
// "do these two runs' verdicts on the same items agree."

/** Whether a run's own verdict on one item counts as "pass" — every gate criterion true for audit,
 * `isCorrect` for grading. No reference involved: this is the run's opinion of itself. */
function itemVerdictPass(task: EvalTask, output: unknown): boolean {
  return task === 'audit'
    ? isGatePass(output as Partial<Record<AuditGateCriterion, boolean>>)
    : (output as { isCorrect: boolean }).isCorrect;
}

/**
 * Pairs two runs' own verdicts on their shared items, with no reference involved. Used both for the
 * reference-free comparison report (candidate vs. baseline) and for noise-floor repeats (the same
 * variant run twice) — in both cases the question is only whether the two runs agree with each
 * other, not whether either is right.
 */
export function extractItemVerdictPairedOutcomes(
  task: EvalTask,
  aResults: EvalResultRow[],
  bResults: EvalResultRow[],
): PairedItemOutcome[] {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  const itemIds = new Set([...aByItem.keys(), ...bByItem.keys()]);
  const outcomes: PairedItemOutcome[] = [];
  for (const itemId of itemIds) {
    const a = aByItem.get(itemId);
    const b = bByItem.get(itemId);
    if (!a?.output || !b?.output) continue; // one run errored on this item — no pair
    outcomes.push({
      itemId,
      baselinePass: itemVerdictPass(task, a.output),
      candidatePass: itemVerdictPass(task, b.output),
    });
  }
  return outcomes;
}

export interface CriterionFlip {
  criterion: AuditGateCriterion;
  /** Items where both runs carry this criterion. */
  n: number;
  /** Items where the two runs' verdicts on this criterion disagree. */
  flips: number;
  flipRate: number;
}

/** Audit only: per-criterion disagreement between two runs, independent of reference — a flip is any
 * item where the two runs' own verdicts on that criterion differ, whichever direction. */
export function auditCriterionFlips(aResults: EvalResultRow[], bResults: EvalResultRow[]): CriterionFlip[] {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  const itemIds = new Set([...aByItem.keys(), ...bByItem.keys()]);

  return AUDIT_GATE_CRITERIA.map((criterion) => {
    let n = 0;
    let flips = 0;
    for (const itemId of itemIds) {
      const aOutput = aByItem.get(itemId)?.output as Partial<Record<AuditGateCriterion, boolean>> | null | undefined;
      const bOutput = bByItem.get(itemId)?.output as Partial<Record<AuditGateCriterion, boolean>> | null | undefined;
      if (aOutput?.[criterion] === undefined || bOutput?.[criterion] === undefined) continue;
      n++;
      if (aOutput[criterion] !== bOutput[criterion]) flips++;
    }
    return { criterion, n, flips, flipRate: n > 0 ? flips / n : NaN };
  });
}

export interface CriterionFlagRate {
  criterion: AuditGateCriterion;
  n: number;
  flagged: number;
  flagRate: number;
}

/** Audit only: one run's own flag rate per criterion (the fraction of its items where that
 * criterion's verdict is false), independent of any other run or of reference. */
export function auditFlagRates(results: EvalResultRow[]): CriterionFlagRate[] {
  return AUDIT_GATE_CRITERIA.map((criterion) => {
    const withOutput = results.filter((r) => (r.output as Partial<Record<AuditGateCriterion, boolean>> | null)?.[criterion] !== undefined);
    const flagged = withOutput.filter((r) => (r.output as Partial<Record<AuditGateCriterion, boolean>>)[criterion] === false).length;
    return { criterion, n: withOutput.length, flagged, flagRate: withOutput.length > 0 ? flagged / withOutput.length : NaN };
  });
}

export type GroupingComparison = 'identical-groups' | 'different-groupings' | 'unknown';

/** Whether two runs' `settings` (`eval-run --group-size`/`--shuffle-groups`) mean they saw
 * identical audit groupings or different ones: a same-group repeat's disagreement is the
 * run-to-run noise floor, a different-grouping repeat's disagreement is the (much larger)
 * group-context sensitivity the audit task shows. `unknown` when either run predates
 * `groupSize` being recorded in settings. */
export function groupingComparisonFor(a: EvalRunRow, b: EvalRunRow): GroupingComparison {
  const aSettings = a.settings as { groupSize?: number; shuffleSeed?: number | null };
  const bSettings = b.settings as { groupSize?: number; shuffleSeed?: number | null };
  if (aSettings.groupSize === undefined || bSettings.groupSize === undefined) return 'unknown';
  if (aSettings.groupSize !== bSettings.groupSize) return 'different-groupings';
  return (aSettings.shuffleSeed ?? null) === (bSettings.shuffleSeed ?? null) ? 'identical-groups' : 'different-groupings';
}

const AUDIT_DISAGREEMENT_ITEM_CAP = 60;

export interface AuditDisagreementItem {
  itemId: string;
  baselineVerdict: Partial<Record<AuditGateCriterion, boolean>>;
  candidateVerdict: Partial<Record<AuditGateCriterion, boolean>>;
  baselineNotes?: string;
  candidateNotes?: string;
}

/**
 * Audit only: every item where the baseline and candidate runs' verdicts disagree on at least one
 * gate criterion, with each run's per-criterion verdict and stored `notes` — enough for a human to
 * adjudicate which one is right. No reference needed; this is a raw comparison of two runs' outputs.
 */
export function findAuditDisagreements(
  baselineResults: EvalResultRow[],
  candidateResults: EvalResultRow[],
): AuditDisagreementItem[] {
  const baselineByItem = resultByItem(baselineResults);
  const candidateByItem = resultByItem(candidateResults);
  const itemIds = [...new Set([...baselineByItem.keys(), ...candidateByItem.keys()])].sort();

  const disagreements: AuditDisagreementItem[] = [];
  for (const itemId of itemIds) {
    const baselineOutput = baselineByItem.get(itemId)?.output as (Partial<Record<AuditGateCriterion, boolean>> & { notes?: string }) | null | undefined;
    const candidateOutput = candidateByItem.get(itemId)?.output as (Partial<Record<AuditGateCriterion, boolean>> & { notes?: string }) | null | undefined;
    if (!baselineOutput || !candidateOutput) continue;
    if (!AUDIT_GATE_CRITERIA.some((c) => baselineOutput[c] !== candidateOutput[c])) continue;

    disagreements.push({
      itemId,
      baselineVerdict: Object.fromEntries(AUDIT_GATE_CRITERIA.map((c) => [c, baselineOutput[c]])),
      candidateVerdict: Object.fromEntries(AUDIT_GATE_CRITERIA.map((c) => [c, candidateOutput[c]])),
      baselineNotes: baselineOutput.notes,
      candidateNotes: candidateOutput.notes,
    });
  }
  return disagreements;
}

/** Renders `findAuditDisagreements`' output as a markdown section, capped at
 * `AUDIT_DISAGREEMENT_ITEM_CAP` items with a count of the rest — for `--out` reports only; the
 * console summary stays short. */
function buildAuditDisagreementSection(candidateLabel: string, disagreements: AuditDisagreementItem[]): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`## Items to adjudicate — ${candidateLabel}`);
  lines.push('');
  if (disagreements.length === 0) {
    lines.push('No disagreements.');
    return lines;
  }

  const shown = disagreements.slice(0, AUDIT_DISAGREEMENT_ITEM_CAP);
  lines.push('| Item | Criterion | Baseline | Candidate | Baseline notes | Candidate notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const d of shown) {
    for (const c of AUDIT_GATE_CRITERIA) {
      if (d.baselineVerdict[c] === d.candidateVerdict[c]) continue;
      lines.push(`| ${d.itemId} | ${c} | ${d.baselineVerdict[c]} | ${d.candidateVerdict[c]} | ${d.baselineNotes ?? ''} | ${d.candidateNotes ?? ''} |`);
    }
  }
  if (disagreements.length > AUDIT_DISAGREEMENT_ITEM_CAP) {
    lines.push('');
    lines.push(`...and ${disagreements.length - AUDIT_DISAGREEMENT_ITEM_CAP} more item(s) not shown.`);
  }
  return lines;
}

export interface ReferenceFreeVariantComparison {
  candidateRunId: string;
  candidateModel: string;
  itemVerdictAgreement: PairedComparisonResult;
  /** Audit only. */
  criterionFlips?: CriterionFlip[];
  /** Audit only. */
  candidateFlagRates?: CriterionFlagRate[];
  candidateCostLatency: RunCostLatency;
  /** Audit only. */
  auditDisagreements?: AuditDisagreementItem[];
}

export interface ReferenceFreeNoiseFloor {
  model: string;
  runIds: [string, string];
  comparison: PairedComparisonResult;
  grouping: GroupingComparison;
}

const NO_REFERENCE_LABEL = 'no reference: stability and agreement only; no accuracy verdict';

/**
 * Renders the reference-free comparison report: item-level verdict agreement between each candidate and
 * the baseline, per-criterion flip counts and flag rates (audit only), cost and latency per run,
 * and the noise floor from any repeats — labelled by whether the repeats used identical groupings
 * or different ones, since regrouping alone moves audit verdicts. No non-inferiority verdict
 * anywhere in this report; there is no reference to check one against.
 */
export function buildReferenceFreeCompareMarkdown(params: {
  task: EvalTask;
  setId: string;
  baselineRunId: string;
  baselineModel: string;
  baselineFlagRates?: CriterionFlagRate[];
  baselineCostLatency: RunCostLatency;
  variants: ReferenceFreeVariantComparison[];
  noiseFloors: ReferenceFreeNoiseFloor[];
  generatedAt: string;
}): string {
  const isAudit = params.task === 'audit';
  const lines: string[] = [];
  lines.push(`# Eval compare — ${params.task} — set ${params.setId}`);
  lines.push('');
  lines.push(`**${NO_REFERENCE_LABEL}**`);
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Baseline: run ${params.baselineRunId} (${params.baselineModel})`);
  lines.push('');
  lines.push('## Item-level verdict agreement');
  lines.push('');
  lines.push('| Candidate | n | Baseline rate | Candidate rate | Diff | Discordant (baseline-only / candidate-only) | McNemar p | 95% CI |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const v of params.variants) {
    const c = v.itemVerdictAgreement;
    lines.push(`| ${v.candidateModel} (run ${v.candidateRunId}) | ${c.n} | ${formatOrNA(c.baselinePassRate, 4)} | ${formatOrNA(c.candidatePassRate, 4)} | ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} | ${c.discordant.baselineOnly} / ${c.discordant.candidateOnly} | ${c.mcnemarPValue.toFixed(4)} | [${c.ci95.lower.toFixed(4)}, ${c.ci95.upper.toFixed(4)}] |`);
  }

  if (isAudit) {
    lines.push('');
    lines.push('## Per-criterion flip counts');
    for (const v of params.variants) {
      lines.push('');
      lines.push(`### ${v.candidateModel} (run ${v.candidateRunId})`);
      lines.push('');
      lines.push('| Criterion | n | Flips | Flip rate |');
      lines.push('|---|---|---|---|');
      for (const f of v.criterionFlips ?? []) {
        lines.push(`| ${f.criterion} | ${f.n} | ${f.flips} | ${formatOrNA(f.flipRate, 4)} |`);
      }
    }

    lines.push('');
    lines.push('## Flag rate per criterion');
    lines.push('');
    lines.push(`### Baseline: ${params.baselineModel} (run ${params.baselineRunId})`);
    lines.push('');
    lines.push('| Criterion | n | Flagged | Flag rate |');
    lines.push('|---|---|---|---|');
    for (const f of params.baselineFlagRates ?? []) {
      lines.push(`| ${f.criterion} | ${f.n} | ${f.flagged} | ${formatOrNA(f.flagRate, 4)} |`);
    }
    for (const v of params.variants) {
      lines.push('');
      lines.push(`### ${v.candidateModel} (run ${v.candidateRunId})`);
      lines.push('');
      lines.push('| Criterion | n | Flagged | Flag rate |');
      lines.push('|---|---|---|---|');
      for (const f of v.candidateFlagRates ?? []) {
        lines.push(`| ${f.criterion} | ${f.n} | ${f.flagged} | ${formatOrNA(f.flagRate, 4)} |`);
      }
    }
  }

  lines.push('');
  lines.push('## Cost and latency per run');
  lines.push('');
  lines.push('| Run | n | Cost/item | Latency p50 | Latency p95 |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| ${params.baselineModel} (run ${params.baselineRunId}, baseline) | ${params.baselineCostLatency.n} | ${formatOrNA(params.baselineCostLatency.costPerItemUsd, 6, { prefix: '$' })} | ${formatOrNA(params.baselineCostLatency.latencyMsP50, 0, { suffix: 'ms' })} | ${formatOrNA(params.baselineCostLatency.latencyMsP95, 0, { suffix: 'ms' })} |`);
  for (const v of params.variants) {
    lines.push(`| ${v.candidateModel} (run ${v.candidateRunId}) | ${v.candidateCostLatency.n} | ${formatOrNA(v.candidateCostLatency.costPerItemUsd, 6, { prefix: '$' })} | ${formatOrNA(v.candidateCostLatency.latencyMsP50, 0, { suffix: 'ms' })} | ${formatOrNA(v.candidateCostLatency.latencyMsP95, 0, { suffix: 'ms' })} |`);
  }

  lines.push(...buildNoiseFloorSection(
    params.noiseFloors,
    ['Model', 'Runs', 'Grouping', 'n', 'Diff', 'McNemar p', '95% CI'],
    (nf) => {
      const c = nf.comparison;
      return `| ${nf.model} | ${nf.runIds.join(', ')} | ${nf.grouping} | ${c.n} | ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} | ${c.mcnemarPValue.toFixed(4)} | [${c.ci95.lower.toFixed(4)}, ${c.ci95.upper.toFixed(4)}] |`;
    },
  ));

  if (isAudit) {
    for (const v of params.variants) {
      lines.push(...buildAuditDisagreementSection(`${v.candidateModel} (run ${v.candidateRunId})`, v.auditDisagreements ?? []));
    }
  }

  return lines.join('\n') + '\n';
}

export interface AuditCriterionVerdict {
  criterion: AuditGateCriterion;
  baseline: PrecisionRecallF1;
  candidate: PrecisionRecallF1;
  recallOk: boolean;
  precisionOk: boolean;
  pass: boolean;
}

/**
 * The audit task's real non-inferiority verdict: each of the six gate criteria's own recall and
 * precision, computed independently for the baseline and the candidate (not paired), checked
 * against a tolerance (recall >= baseline - tolerance, precision >= baseline -
 * precisionTolerance). A criterion with no reference-backed data for either variant passes
 * vacuously: there's nothing to regress. `tolerance` defaults to the audit task's own default (no
 * experiment override) when the caller has none to pass; `eval-compare` always resolves and passes
 * one explicitly, since an experiment's `decision_rule` may override it.
 */
export function auditPerCriterionVerdict(
  baselineOutcomes: AuditItemOutcome[],
  candidateOutcomes: AuditItemOutcome[],
  tolerance: ResolvedTolerance = resolveTolerance('audit'),
): AuditCriterionVerdict[] {
  const precisionTolerance = tolerance.precisionTolerance ?? tolerance.tolerance;

  return AUDIT_GATE_CRITERIA.map((criterion) => {
    const baseline = criterionPrecisionRecallF1(baselineOutcomes, criterion);
    const candidate = criterionPrecisionRecallF1(candidateOutcomes, criterion);
    const recallOk = Number.isNaN(baseline.recall) || Number.isNaN(candidate.recall)
      || candidate.recall >= baseline.recall - tolerance.tolerance;
    const precisionOk = Number.isNaN(baseline.precision) || Number.isNaN(candidate.precision)
      || candidate.precision >= baseline.precision - precisionTolerance;
    return { criterion, baseline, candidate, recallOk, precisionOk, pass: recallOk && precisionOk };
  });
}

export interface VariantComparison {
  candidateRunId: string;
  candidateModel: string;
  /** The pooled McNemar test over every "should flag" pair (audit) or the exact false-negative
   * paired test (grading) — see the module doc comment for why audit's version is pooled and
   * informational rather than the task's real headline. */
  comparison: PairedComparisonResult;
  /** Grading's real non-inferiority verdict; for audit, the same pooled statistic's verdict,
   * kept for the table but not the headline (`auditPerCriterion` is). */
  verdict: NonInferiorityVerdict;
  /** Audit only: the real, per-criterion non-inferiority verdict. */
  auditPerCriterion?: AuditCriterionVerdict[];
  /** Audit only: every item where the baseline and this candidate disagree, for human adjudication. */
  auditDisagreements?: AuditDisagreementItem[];
}

export interface NoiseFloor {
  model: string;
  runIds: [string, string];
  comparison: PairedComparisonResult;
}

/** Grading only: the answer-key exclusion applied before this report's accuracy figures were
 * computed. `excludedItemCount` is 0 when `included` is true (`--include-rejected-keys`). */
export interface RejectedKeysReport {
  questions: RejectedKeyQuestion[];
  excludedItemCount: number;
  included: boolean;
}

export function buildCompareMarkdown(params: {
  task: EvalTask;
  setId: string;
  baselineRunId: string;
  baselineModel: string;
  variants: VariantComparison[];
  noiseFloors: NoiseFloor[];
  generatedAt: string;
  rejectedKeys?: RejectedKeysReport;
  /** Which tolerance rule the verdicts below were judged against: `describeToleranceSource`'s
   * output. Defaults to "task default" for a caller that hasn't resolved one, matching the
   * behaviour before an experiment could override it. */
  toleranceNote?: string;
}): string {
  const isAudit = params.task === 'audit';
  const lines: string[] = [];
  lines.push(`# Eval compare — ${params.task} — set ${params.setId}`);
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Baseline: run ${params.baselineRunId} (${params.baselineModel})`);
  lines.push(`Tolerance: ${params.toleranceNote ?? 'task default'}`);

  if (params.rejectedKeys) {
    const { questions, excludedItemCount, included } = params.rejectedKeys;
    lines.push('');
    if (questions.length === 0) {
      lines.push('Rejected-key questions: none.');
    } else {
      const itemCount = questions.reduce((n, q) => n + q.itemIds.length, 0);
      lines.push(included
        ? `Rejected-key questions: ${questions.length} (${itemCount} item(s)), included in the accuracy figures below (--include-rejected-keys).`
        : `Rejected-key questions: ${questions.length} (${excludedItemCount} item(s) excluded from the accuracy figures below) — pass --include-rejected-keys to include them.`);
      lines.push('');
      lines.push('| question_group | question |');
      lines.push('|---|---|');
      for (const q of questions) lines.push(`| ${q.questionRef} | ${q.question} |`);
    }
  }

  lines.push('');
  lines.push('## Variants');
  lines.push('');
  if (isAudit) {
    lines.push('Non-inferior here is the per-criterion verdict below (all six criteria pass their own');
    lines.push('recall/precision tolerance) — not the pooled statistic in this table, which is informational only.');
    lines.push('');
  }
  lines.push(isAudit
    ? '| Candidate | n | Baseline rate | Candidate rate | Diff | Pooled McNemar p (correlated pairs) | 95% CI |'
    : '| Candidate | n | Baseline rate | Candidate rate | Diff | McNemar p | 95% CI | Non-inferior |');
  lines.push(isAudit ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|');
  for (const variant of params.variants) {
    const c = variant.comparison;
    const row = isAudit
      ? `| ${variant.candidateModel} (run ${variant.candidateRunId}) | ${c.n} | ${formatOrNA(c.baselinePassRate, 4)} | ${formatOrNA(c.candidatePassRate, 4)} | ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} | ${c.mcnemarPValue.toFixed(4)} | [${c.ci95.lower.toFixed(4)}, ${c.ci95.upper.toFixed(4)}] |`
      : `| ${variant.candidateModel} (run ${variant.candidateRunId}) | ${c.n} | ${formatOrNA(c.baselinePassRate, 4)} | ${formatOrNA(c.candidatePassRate, 4)} | ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} | ${c.mcnemarPValue.toFixed(4)} | [${c.ci95.lower.toFixed(4)}, ${c.ci95.upper.toFixed(4)}] | ${variant.verdict.nonInferior ? 'yes' : 'no'} |`;
    lines.push(row);
  }

  if (isAudit) {
    lines.push('');
    lines.push('## Per-criterion verdict (audit headline)');
    for (const variant of params.variants) {
      const perCriterion = variant.auditPerCriterion ?? [];
      const failed = perCriterion.filter((c) => !c.pass);
      lines.push('');
      lines.push(`### ${variant.candidateModel} (run ${variant.candidateRunId})`);
      lines.push('');
      lines.push(failed.length === 0
        ? '**All criteria pass.**'
        : `**Failed: ${failed.map((c) => c.criterion).join(', ')}.**`);
      lines.push('');
      lines.push('| Criterion | Baseline recall | Candidate recall | Baseline precision | Candidate precision | Pass |');
      lines.push('|---|---|---|---|---|---|');
      for (const c of perCriterion) {
        lines.push(`| ${c.criterion} | ${formatOrNA(c.baseline.recall, 4)} | ${formatOrNA(c.candidate.recall, 4)} | ${formatOrNA(c.baseline.precision, 4)} | ${formatOrNA(c.candidate.precision, 4)} | ${c.pass ? 'yes' : 'no'} |`);
      }
    }
  } else {
    lines.push('');
    for (const variant of params.variants) {
      lines.push(`- **${variant.candidateModel}**: ${variant.verdict.reason}`);
    }
  }

  lines.push(...buildNoiseFloorSection(
    params.noiseFloors,
    ['Model', 'Runs', 'n', 'Diff', 'McNemar p', '95% CI'],
    (nf) => {
      const c = nf.comparison;
      return `| ${nf.model} | ${nf.runIds.join(', ')} | ${c.n} | ${c.diff >= 0 ? '+' : ''}${c.diff.toFixed(4)} | ${c.mcnemarPValue.toFixed(4)} | [${c.ci95.lower.toFixed(4)}, ${c.ci95.upper.toFixed(4)}] |`;
    },
  ));

  if (isAudit) {
    for (const variant of params.variants) {
      lines.push(...buildAuditDisagreementSection(`${variant.candidateModel} (run ${variant.candidateRunId})`, variant.auditDisagreements ?? []));
    }
  }

  return lines.join('\n') + '\n';
}
