/**
 * Paired comparison between a baseline variant and a candidate variant scored on the same items:
 * agreement, discordant counts, McNemar's exact test on the discordant pairs, a 95% CI on the
 * difference in pass rate, and the non-inferiority verdict against the task's tolerance (`tolerances.ts`).
 */

import { TASK_TOLERANCES } from './tolerances';
import type { EvalTask } from './types';

/**
 * `baselinePass`/`candidatePass` mean "this item counts toward the task's primary metric" —
 * for a higher-is-better metric (recall, judge pass rate) that's the good outcome; for a
 * lower-is-better metric (false-negative rate, edit distance bucketed pass/fail) it's the *bad*
 * outcome, so the resulting pass rate IS the metric `nonInferiorityVerdict` bounds by tolerance.
 */
export interface PairedItemOutcome {
  itemId: string;
  baselinePass: boolean;
  candidatePass: boolean;
}

export interface PairedComparisonResult {
  n: number;
  baselinePassRate: number;
  candidatePassRate: number;
  /** candidatePassRate - baselinePassRate. */
  diff: number;
  /** Items where the variants disagreed, split by which variant passed. */
  discordant: { baselineOnly: number; candidateOnly: number };
  /** Two-sided exact binomial test on the discordant pairs (McNemar's test). 1 when there are no
   * discordant pairs — the variants agreed on every item, so there is nothing to distinguish them. */
  mcnemarPValue: number;
  /** 95% CI on `diff`, normal approximation from the paired difference's sample variance. */
  ci95: { lower: number; upper: number };
}

function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * McNemar's exact test: two-sided p-value for whether `b` and `c` (the discordant counts) come
 * from a fair (p=0.5) binomial split. `n = b + c`; each term is `C(n, i) * 0.5^n`, summed from 0
 * to `min(b, c)` and doubled for the two-sided test, capped at 1.
 */
export function mcnemarExactPValue(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tailProbability = 0;
  for (let i = 0; i <= k; i++) {
    tailProbability += Math.exp(logChoose(n, i) - n * Math.log(2));
  }
  return Math.min(1, 2 * tailProbability);
}

/**
 * Compares a baseline and a candidate variant on the same set of items. Throws if `outcomes` is
 * empty — a comparison needs at least one shared item.
 */
export function pairedComparison(outcomes: PairedItemOutcome[]): PairedComparisonResult {
  const n = outcomes.length;
  if (n === 0) {
    throw new Error('pairedComparison requires at least one item');
  }

  let baselinePassCount = 0;
  let candidatePassCount = 0;
  let baselineOnly = 0;
  let candidateOnly = 0;
  let sumDiff = 0;
  let sumDiffSquared = 0;

  for (const outcome of outcomes) {
    if (outcome.baselinePass) baselinePassCount++;
    if (outcome.candidatePass) candidatePassCount++;
    if (outcome.baselinePass && !outcome.candidatePass) baselineOnly++;
    if (!outcome.baselinePass && outcome.candidatePass) candidateOnly++;

    const d = (outcome.candidatePass ? 1 : 0) - (outcome.baselinePass ? 1 : 0);
    sumDiff += d;
    sumDiffSquared += d * d;
  }

  const baselinePassRate = baselinePassCount / n;
  const candidatePassRate = candidatePassCount / n;
  const diff = sumDiff / n;
  // Var(d) = E[d^2] - E[d]^2, for d_i in {-1, 0, 1}; SE of the mean is sqrt(Var(d) / n).
  const variance = Math.max(0, sumDiffSquared / n - diff * diff);
  const standardError = Math.sqrt(variance / n);
  const Z_95 = 1.96;

  return {
    n,
    baselinePassRate,
    candidatePassRate,
    diff,
    discordant: { baselineOnly, candidateOnly },
    mcnemarPValue: mcnemarExactPValue(baselineOnly, candidateOnly),
    ci95: { lower: diff - Z_95 * standardError, upper: diff + Z_95 * standardError },
  };
}

export interface NonInferiorityVerdict {
  task: EvalTask;
  nonInferior: boolean;
  primaryMetric: string;
  tolerance: number;
  direction: 'higher-is-better' | 'lower-is-better';
  baselinePassRate: number;
  candidatePassRate: number;
  reason: string;
}

/**
 * Applies a task's tolerance (`tolerances.ts`) to a paired comparison's pass rates. This
 * checks only the primary-metric direction/tolerance pair; a task's secondary conditions
 * (grading's false-positive cap, generation's reject-rate cap, etc. — see
 * `TASK_TOLERANCES[task].description`) are not expressible from pass/fail pairs alone and
 * are left to the caller to check against its own per-item breakdown.
 */
export function nonInferiorityVerdict(task: EvalTask, comparison: PairedComparisonResult): NonInferiorityVerdict {
  const spec = TASK_TOLERANCES[task];
  const nonInferior = spec.direction === 'higher-is-better'
    ? comparison.candidatePassRate >= comparison.baselinePassRate - spec.tolerance
    : comparison.candidatePassRate <= comparison.baselinePassRate + spec.tolerance;

  const comparator = spec.direction === 'higher-is-better' ? '>=' : '<=';
  const bound = spec.direction === 'higher-is-better'
    ? comparison.baselinePassRate - spec.tolerance
    : comparison.baselinePassRate + spec.tolerance;

  return {
    task,
    nonInferior,
    primaryMetric: spec.primaryMetric,
    tolerance: spec.tolerance,
    direction: spec.direction,
    baselinePassRate: comparison.baselinePassRate,
    candidatePassRate: comparison.candidatePassRate,
    reason: `${spec.primaryMetric}: candidate ${comparison.candidatePassRate.toFixed(4)} ${comparator} ${bound.toFixed(4)} (baseline ${comparison.baselinePassRate.toFixed(4)}, tolerance ${spec.tolerance})`,
  };
}

// ── Continuous-metric (mapping task) comparisons ──────────────────────────
//
// The mapping task's primary metric (per-topic heading-set F1) is continuous, not a per-item
// pass/fail, so McNemar's test doesn't apply. The functions below are the continuous-metric
// analogue: the mean difference with a normal-approximation CI (as `pairedComparison`'s CI on a
// pass-rate difference), and an exact sign test for the p-value, because F1 has a ceiling at 1
// that most topics sit on and a variance-based test would treat a few identical small
// differences among many ties as strong evidence.

export interface MeanCi95 {
  mean: number;
  ci95: { lower: number; upper: number };
}

/** Sample mean and a 95% CI (normal approximation, sample variance with Bessel's correction).
 * Undefined for an empty sample — there's nothing to report. */
export function meanAndCi95(values: number[]): MeanCi95 | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const standardError = Math.sqrt(variance / n);
  const Z_95 = 1.96;
  return { mean, ci95: { lower: mean - Z_95 * standardError, upper: mean + Z_95 * standardError } };
}

export interface PairedMappingOutcome {
  itemId: string;
  baselineF1: number;
  candidateF1: number;
}

export interface MappingPairedComparisonResult {
  n: number;
  baselineMeanF1: number;
  candidateMeanF1: number;
  /** candidateMeanF1 - baselineMeanF1. */
  diff: number;
  /** Items where the candidate's F1 is higher, lower, or equal to the baseline's. */
  candidateBetter: number;
  baselineBetter: number;
  ties: number;
  /** Two-sided exact sign test over the non-tied items (see `signTestPValue`). */
  pValue: number;
  ci95: { lower: number; upper: number };
}

/**
 * Paired comparison of two variants' per-topic F1 scores on the same items: mean difference with a
 * normal-approximation 95% CI, the better/worse/tied split, and an exact two-sided sign test over
 * the non-tied items (`signTestPValue`). With 40 topics and most of them tied at F1 = 1, the sign
 * test is honest about how little a handful of differing topics can show.
 */
export function pairedMappingComparison(outcomes: PairedMappingOutcome[]): MappingPairedComparisonResult {
  const n = outcomes.length;
  if (n === 0) {
    throw new Error('pairedMappingComparison requires at least one item');
  }

  const diffs = outcomes.map((o) => o.candidateF1 - o.baselineF1);
  const { mean: diff, ci95 } = meanAndCi95(diffs)!;
  const candidateBetter = diffs.filter((d) => d > 0).length;
  const baselineBetter = diffs.filter((d) => d < 0).length;
  const ties = n - candidateBetter - baselineBetter;

  return {
    n,
    baselineMeanF1: outcomes.reduce((a, o) => a + o.baselineF1, 0) / n,
    candidateMeanF1: outcomes.reduce((a, o) => a + o.candidateF1, 0) / n,
    diff,
    candidateBetter,
    baselineBetter,
    ties,
    pValue: signTestPValue(candidateBetter, baselineBetter),
    ci95,
  };
}

/**
 * Exact two-sided sign test on the items where the two variants differ: under the null, each
 * such item is equally likely to favour either side. Ties carry no information and are left out,
 * so a metric with a ceiling (most topics at F1 = 1) cannot manufacture significance from a few
 * identical small differences the way a variance-based test would. p = 1 when nothing differs.
 */
export function signTestPValue(positives: number, negatives: number): number {
  const m = positives + negatives;
  if (m === 0) return 1;
  const k = Math.min(positives, negatives);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomialCoefficient(m, i);
  return Math.min(1, (2 * tail) / Math.pow(2, m));
}

function binomialCoefficient(nn: number, kk: number): number {
  let result = 1;
  for (let i = 1; i <= kk; i++) result = (result * (nn - kk + i)) / i;
  return result;
}

/** The mapping task's noise floor: mean absolute F1 difference between two repeats of the same
 * variant on the same items. */
export function mappingNoiseFloor(outcomes: { itemId: string; f1A: number; f1B: number }[]): number {
  if (outcomes.length === 0) return NaN;
  return outcomes.reduce((sum, o) => sum + Math.abs(o.f1A - o.f1B), 0) / outcomes.length;
}
