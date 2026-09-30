/**
 * Pure logic behind `eval-compare` for the mapping task. Mapping's primary metric (per-topic
 * heading-set F1, stored in `eval_results.score` by `eval-run`) is continuous, not a per-item
 * pass/fail, so it gets its own report shape rather than reusing the audit/grading pass-rate one.
 * Reference is always present for this task (deterministic, set at `eval-set-create` time), so
 * there's no reference-free fallback to write. No Supabase or LLM calls here.
 */

import { meanAndCi95, type MappingPairedComparisonResult } from '../scoring';
import type { EvalResultRow } from '../db';
import { resultByItem, runCostLatency, formatOrNA, buildNoiseFloorSection, type RunCostLatency } from './shared';

export interface PairedMappingOutcome {
  itemId: string;
  baselineF1: number;
  candidateF1: number;
}

/** Pairs two mapping runs' per-item F1 scores (`eval_results.score`) on their shared items — the
 * raw material for both a candidate-vs-baseline comparison and a noise-floor repeat comparison. */
export function extractMappingPairedOutcomes(aResults: EvalResultRow[], bResults: EvalResultRow[]): PairedMappingOutcome[] {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  const outcomes: PairedMappingOutcome[] = [];
  for (const [itemId, a] of aByItem) {
    const b = bByItem.get(itemId);
    if (a.score === null || !b || b.score === null) continue;
    outcomes.push({ itemId, baselineF1: a.score, candidateF1: b.score });
  }
  return outcomes;
}

export interface MappingRunStats {
  n: number;
  meanF1: number;
  f1Ci95: { lower: number; upper: number };
  fractionF1Perfect: number;
  totalUnresolved: number;
  totalNestedDuplicates: number;
  costLatency: RunCostLatency;
}

/** One run's own mapping stats, read straight from its `eval_results` rows — independent of any
 * other run, the same role `runCostLatency` plays for cost/latency. */
export function mappingRunStats(results: EvalResultRow[]): MappingRunStats {
  const scored = results.filter((r) => r.score !== null);
  const f1Values = scored.map((r) => r.score!);
  const meanCi = meanAndCi95(f1Values);
  const totalUnresolved = results.reduce((sum, r) => sum + ((r.deterministic_checks as { unresolved?: number } | null)?.unresolved ?? 0), 0);
  const totalNestedDuplicates = results.reduce((sum, r) => sum + ((r.deterministic_checks as { nested_duplicates?: number } | null)?.nested_duplicates ?? 0), 0);

  return {
    n: scored.length,
    meanF1: meanCi?.mean ?? NaN,
    f1Ci95: meanCi?.ci95 ?? { lower: NaN, upper: NaN },
    fractionF1Perfect: scored.length > 0 ? scored.filter((r) => r.score === 1).length / scored.length : NaN,
    totalUnresolved,
    totalNestedDuplicates,
    costLatency: runCostLatency(results),
  };
}

export interface MappingVariantComparison {
  candidateRunId: string;
  candidateModel: string;
  candidateStats: MappingRunStats;
  paired: MappingPairedComparisonResult;
}

export interface MappingNoiseFloorEntry {
  model: string;
  runIds: [string, string];
  n: number;
  meanAbsDiff: number;
}

/**
 * Renders the mapping task's comparison report: each candidate's own stats (mean F1 with a 95%
 * CI, fraction of topics scored a perfect 1, unresolved-heading and nested-duplicate counts, cost
 * and latency) next to the baseline's, a paired test on the per-topic F1 difference, and the noise
 * floor from any repeats (mean absolute F1 difference between them).
 */
export function buildMappingCompareMarkdown(params: {
  setId: string;
  baselineRunId: string;
  baselineModel: string;
  baselineStats: MappingRunStats;
  variants: MappingVariantComparison[];
  noiseFloors: MappingNoiseFloorEntry[];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Eval compare — mapping — set ${params.setId}`);
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Baseline: run ${params.baselineRunId} (${params.baselineModel})`);
  lines.push('');
  lines.push('## Per-run stats');
  lines.push('');
  lines.push('| Run | n | Mean F1 | 95% CI | Fraction F1=1 | Unresolved | Nested dup. | Cost/item | Latency p50 | Latency p95 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const statsRow = (label: string, stats: MappingRunStats) =>
    `| ${label} | ${stats.n} | ${formatOrNA(stats.meanF1, 4)} | [${formatOrNA(stats.f1Ci95.lower, 4)}, ${formatOrNA(stats.f1Ci95.upper, 4)}] | ${formatOrNA(stats.fractionF1Perfect, 4)} | ${stats.totalUnresolved} | ${stats.totalNestedDuplicates} | ${formatOrNA(stats.costLatency.costPerItemUsd, 6, { prefix: '$' })} | ${formatOrNA(stats.costLatency.latencyMsP50, 0, { suffix: 'ms' })} | ${formatOrNA(stats.costLatency.latencyMsP95, 0, { suffix: 'ms' })} |`;
  lines.push(statsRow(`${params.baselineModel} (run ${params.baselineRunId}, baseline)`, params.baselineStats));
  for (const v of params.variants) {
    lines.push(statsRow(`${v.candidateModel} (run ${v.candidateRunId})`, v.candidateStats));
  }

  lines.push('');
  lines.push('## Paired comparison against baseline');
  lines.push('');
  lines.push('| Candidate | n | Baseline mean F1 | Candidate mean F1 | Diff | Better / worse / tied | Sign-test p | 95% CI |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const v of params.variants) {
    const p = v.paired;
    lines.push(`| ${v.candidateModel} (run ${v.candidateRunId}) | ${p.n} | ${formatOrNA(p.baselineMeanF1, 4)} | ${formatOrNA(p.candidateMeanF1, 4)} | ${p.diff >= 0 ? '+' : ''}${p.diff.toFixed(4)} | ${p.candidateBetter} / ${p.baselineBetter} / ${p.ties} | ${p.pValue.toFixed(4)} | [${p.ci95.lower.toFixed(4)}, ${p.ci95.upper.toFixed(4)}] |`);
  }

  lines.push(...buildNoiseFloorSection(
    params.noiseFloors,
    ['Model', 'Runs', 'n', 'Mean |F1 diff|'],
    (nf) => `| ${nf.model} | ${nf.runIds.join(', ')} | ${nf.n} | ${formatOrNA(nf.meanAbsDiff, 4)} |`,
  ));

  return lines.join('\n') + '\n';
}
