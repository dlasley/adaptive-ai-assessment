/**
 * Pure scheduling and scoring logic shared by `eval-run`'s audit and grading tasks: how items
 * are grouped into calls, how multiple variants are interleaved, the grading label→expected-outcome
 * mapping, and the `eval_runs.summary` shapes for each task. No LLM or Supabase calls here —
 * `eval-run.ts` supplies real data; tests supply fixtures.
 */

import { chunk } from '../mistral-audit';
import type { GradingLabelClass } from './set-builder';

// ── Interleaving and grouping ────────────────────────────────────────────────

export interface InterleavedCall<T, V> {
  variant: V;
  items: T[];
  blockIndex: number;
}

/**
 * Splits `items` into blocks of `blockSize` and, within each block, schedules one call per variant
 * in `variants` order — block 0 for every variant, then block 1 for every variant, and so on
 * (interleaved blocks rather than one variant run start to finish, so time-of-day and
 * provider-routing effects land on every variant equally).
 * `V` is whatever identifies one variant to the caller: a model slug for a single-repeat run, or a
 * `{model, repeatIndex}` pair when `eval-run --repeat` produces more than one pass per model.
 */
export function planInterleavedCalls<T, V>(items: T[], variants: V[], blockSize: number): InterleavedCall<T, V>[] {
  const blocks = chunk(items, blockSize);
  const calls: InterleavedCall<T, V>[] = [];
  blocks.forEach((block, blockIndex) => {
    for (const variant of variants) {
      calls.push({ variant, items: block, blockIndex });
    }
  });
  return calls;
}

/**
 * The audit task's actual unit of an LLM call: `planInterleavedCalls`'s block-level interleaving,
 * with each block further split into `groupSize`-question groups that share one material block —
 * production audits at `AUDIT_GROUP_SIZE` (each question alone); `eval-run --group-size` overrides
 * it to test larger groups. Item order within a block is preserved, so a block of 25 with groupSize
 * 5 becomes 5 five-item groups per variant, in the same relative order `chunk` would produce on its
 * own. Exported so `--group-size` is unit-testable without a live Supabase connection or LLM calls.
 */
export function planAuditGroupCalls<T, V>(
  items: T[],
  variants: V[],
  blockSize: number,
  groupSize: number,
): InterleavedCall<T, V>[] {
  const calls = planInterleavedCalls(items, variants, blockSize);
  const groupCalls: InterleavedCall<T, V>[] = [];
  for (const call of calls) {
    for (const group of chunk(call.items, groupSize)) {
      groupCalls.push({ variant: call.variant, items: group, blockIndex: call.blockIndex });
    }
  }
  return groupCalls;
}

// ── Grading label -> expected outcome ────────────────────────────────────────

/** Score at or above which a grading verdict counts as "correct" — mirrors
 * `CORRECTNESS_THRESHOLDS.SEMANTIC_API_PASS` in apps/web/src/lib/feature-flags.ts, kept as its own
 * constant here since the eval lib doesn't depend on the web app. Used to build the model's own
 * evaluation prompt; reference carries a reviewer verdict, not a score (see `GradingReference`). */
export const GRADING_PASS_SCORE_THRESHOLD = 70;

/** A reviewer's reference verdict for one grading item: whether the submitted answer should have been
 * marked correct, whether the reviewer considered it a borderline call, and why (required whenever
 * `isCorrect` is false or `borderline` is true). `keyCorrect`/`keyNote` are answered once per
 * source question, on the group's first row, and copied onto every item of the group: whether the
 * reviewer judged the answer key itself correct, and (required when it isn't) what the key should
 * be — `isCorrect`/`reason` on a rejected-key item are the reviewer's verdict against the corrected
 * key, not the printed one. */
export interface GradingReference {
  isCorrect: boolean;
  borderline: boolean;
  reason: string | null;
  keyCorrect: boolean;
  keyNote: string | null;
}

/** Whether reference says this item's answer should be marked correct: the reviewer's own verdict. */
export function expectedIsCorrect(reference: GradingReference): boolean {
  return reference.isCorrect;
}

// ── Percentiles ──────────────────────────────────────────────────────────────

/** Nearest-rank percentile over `values` (not interpolated) — `p` in [0, 100]. Returns undefined
 * for an empty input rather than NaN, so a caller can render "n/a" instead of a bogus number. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

// ── Grading summary ──────────────────────────────────────────────────────────

export interface GradingItemOutcome {
  itemId: string;
  labelClass: GradingLabelClass;
  difficulty: string;
  /** Reference, when this item's eval_items row is approved; undefined otherwise (production-verdict-only item). */
  reference?: GradingReference;
  /** The variant's output for this item, or undefined when the call errored. */
  output?: { isCorrect: boolean; score: number };
  error?: 'parse' | 'api' | 'empty';
  latencyMs?: number;
  costUsd?: number;
}

interface RateBucket {
  n: number;
  agreementRate: number;
  falseNegativeRate: number;
  falsePositiveRate: number;
}

function rateBucket(outcomes: GradingItemOutcome[]): RateBucket {
  const withReference = outcomes.filter((o) => o.reference && o.output);
  const n = withReference.length;
  if (n === 0) return { n: 0, agreementRate: NaN, falseNegativeRate: NaN, falsePositiveRate: NaN };

  let agree = 0;
  let falseNegatives = 0; // reference says correct, model says incorrect
  let falsePositives = 0; // reference says incorrect, model says correct
  let expectedCorrectCount = 0;
  let expectedIncorrectCount = 0;

  for (const o of withReference) {
    const expected = expectedIsCorrect(o.reference!);
    const actual = o.output!.isCorrect;
    if (expected === actual) agree++;
    if (expected) {
      expectedCorrectCount++;
      if (!actual) falseNegatives++;
    } else {
      expectedIncorrectCount++;
      if (actual) falsePositives++;
    }
  }

  return {
    n,
    agreementRate: agree / n,
    falseNegativeRate: expectedCorrectCount > 0 ? falseNegatives / expectedCorrectCount : NaN,
    falsePositiveRate: expectedIncorrectCount > 0 ? falsePositives / expectedIncorrectCount : NaN,
  };
}

export interface GradingRunSummary {
  itemCount: number;
  referenceItemCount: number;
  overall: RateBucket;
  parseFailureRate: number;
  latencyMsP50: number | undefined;
  latencyMsP95: number | undefined;
  costPerItemUsd: number | undefined;
  byDifficulty: Record<string, RateBucket>;
  byLabel: Record<string, RateBucket>;
}

export function buildGradingRunSummary(outcomes: GradingItemOutcome[]): GradingRunSummary {
  const itemCount = outcomes.length;
  const referenceItemCount = outcomes.filter((o) => o.reference).length;
  const parseFailures = outcomes.filter((o) => o.error === 'parse').length;
  const latencies = outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== undefined);
  const costs = outcomes.map((o) => o.costUsd).filter((v): v is number => v !== undefined);

  const byDifficulty: Record<string, RateBucket> = {};
  for (const difficulty of new Set(outcomes.map((o) => o.difficulty))) {
    byDifficulty[difficulty] = rateBucket(outcomes.filter((o) => o.difficulty === difficulty));
  }
  const byLabel: Record<string, RateBucket> = {};
  for (const label of new Set(outcomes.map((o) => o.labelClass))) {
    byLabel[label] = rateBucket(outcomes.filter((o) => o.labelClass === label));
  }

  return {
    itemCount,
    referenceItemCount,
    overall: rateBucket(outcomes),
    parseFailureRate: itemCount > 0 ? parseFailures / itemCount : 0,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    costPerItemUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / itemCount : undefined,
    byDifficulty,
    byLabel,
  };
}

// ── Audit summary ────────────────────────────────────────────────────────────

export const AUDIT_GATE_CRITERIA = [
  'answer_correct',
  'grammar_correct',
  'no_hallucination',
  'question_coherent',
  'natural_language',
  'register_appropriate',
] as const;

export type AuditGateCriterion = (typeof AUDIT_GATE_CRITERIA)[number];

export interface AuditItemOutcome {
  itemId: string;
  /** Approved reference verdict per criterion, when this item has been reviewed. */
  reference?: Partial<Record<AuditGateCriterion, boolean>>;
  /** The production auditor's own verdict for this item (`payload.production_audit`), for a
   * production-verdict comparison when reference is absent. */
  productionAudit?: Partial<Record<AuditGateCriterion, boolean>>;
  /** This variant's verdict for the item, or undefined when the call errored. */
  output?: Partial<Record<AuditGateCriterion, boolean>>;
  error?: 'parse' | 'api' | 'empty';
  latencyMs?: number;
  costUsd?: number;
}

export interface PrecisionRecallF1 {
  n: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Precision/recall/F1 for one criterion, treating "should flag" (reference false) as the positive
 * class — recall on "should flag" items is the number the audit task's tolerance
 * (`TASK_TOLERANCES.audit`) is stated against. Exported for `compare/audit-grading.ts`,
 * which needs each variant's own per-criterion numbers (not a paired comparison) to compute the
 * audit task's real per-criterion non-inferiority verdict. */
export function criterionPrecisionRecallF1(outcomes: AuditItemOutcome[], criterion: AuditGateCriterion): PrecisionRecallF1 {
  const withReference = outcomes.filter((o) => o.reference?.[criterion] !== undefined && o.output?.[criterion] !== undefined);
  const n = withReference.length;
  if (n === 0) return { n: 0, precision: NaN, recall: NaN, f1: NaN };

  let truePositives = 0; // reference flags it, variant flags it
  let falsePositives = 0; // reference passes it, variant flags it
  let falseNegatives = 0; // reference flags it, variant passes it

  for (const o of withReference) {
    const referenceFlags = o.reference![criterion] === false;
    const variantFlags = o.output![criterion] === false;
    if (referenceFlags && variantFlags) truePositives++;
    else if (!referenceFlags && variantFlags) falsePositives++;
    else if (referenceFlags && !variantFlags) falseNegatives++;
  }

  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : NaN;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : NaN;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : NaN;
  return { n, precision, recall, f1 };
}

/** Whether an audit verdict passes every gate criterion. Exported for `compare/audit-grading.ts`'s
 * reference-free comparison, which reads a run's own verdict on an item with no reference involved. */
export function isGatePass(verdict: Partial<Record<AuditGateCriterion, boolean>>): boolean {
  return AUDIT_GATE_CRITERIA.every((c) => verdict[c] === true);
}

export interface AuditRunSummary {
  itemCount: number;
  referenceItemCount: number;
  reference: Record<AuditGateCriterion, PrecisionRecallF1> | null;
  overallAccuracyReference: number | undefined;
  productionAgreement: { n: number; agreementRate: number } | null;
  parseFailureRate: number;
  latencyMsP50: number | undefined;
  latencyMsP95: number | undefined;
  costPerItemUsd: number | undefined;
}

export function buildAuditRunSummary(outcomes: AuditItemOutcome[]): AuditRunSummary {
  const itemCount = outcomes.length;
  const withReference = outcomes.filter((o) => o.reference);
  const referenceItemCount = withReference.length;
  const parseFailures = outcomes.filter((o) => o.error === 'parse').length;
  const latencies = outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== undefined);
  const costs = outcomes.map((o) => o.costUsd).filter((v): v is number => v !== undefined);

  const reference: Record<string, PrecisionRecallF1> | null = referenceItemCount > 0
    ? Object.fromEntries(AUDIT_GATE_CRITERIA.map((c) => [c, criterionPrecisionRecallF1(outcomes, c)]))
    : null;

  const overallAccuracyReference = referenceItemCount > 0
    ? withReference.filter((o) => o.output && isGatePass(o.reference!) === isGatePass(o.output)).length / referenceItemCount
    : undefined;

  const withProductionAudit = outcomes.filter((o) => !o.reference && o.productionAudit && o.output);
  const productionAgreement = withProductionAudit.length > 0
    ? {
        n: withProductionAudit.length,
        agreementRate: withProductionAudit.filter((o) => isGatePass(o.productionAudit!) === isGatePass(o.output!)).length / withProductionAudit.length,
      }
    : null;

  return {
    itemCount,
    referenceItemCount,
    reference: reference as Record<AuditGateCriterion, PrecisionRecallF1> | null,
    overallAccuracyReference,
    productionAgreement,
    parseFailureRate: itemCount > 0 ? parseFailures / itemCount : 0,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    costPerItemUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / itemCount : undefined,
  };
}
