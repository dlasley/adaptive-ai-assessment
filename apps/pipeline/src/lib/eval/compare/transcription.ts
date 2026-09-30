/**
 * Pure logic behind `eval-compare` for the transcription task. Transcription's primary metric
 * (1 - normalized edit distance against a checked transcript, stored in `eval_results.score` by
 * `eval-run`) is continuous like mapping's F1, so its paired comparison reuses the same
 * mean-difference-plus-exact-sign-test shape (`meanAndCi95`, `signTestPValue`, both from
 * `scoring.ts`). Unlike mapping, reference for this task is reviewed after the fact
 * (`eval-review-export`/`eval-review-import`) rather than known at `eval-set-create` time, so a set
 * whose reference is still pending falls back to a reference-free report instead — agreement
 * between each candidate and the baseline's own transcript, by the same distance, clearly not an
 * accuracy figure. No Supabase or LLM calls here.
 */

import { meanAndCi95, signTestPValue } from '../scoring';
import { scoreTranscription, scoreTranscriptionWords, countMarkdownTable, NO_CONTENT_MARKER } from '../transcription-scoring';
import { TASK_TOLERANCES, TRANSCRIPTION_MAX_SLIDE_DROP } from '../tolerances';
import type { EvalResultRow } from '../db';
import { resultByItem, runCostLatency, formatOrNA, buildNoiseFloorSection, type RunCostLatency } from './shared';

export interface PairedTranscriptionOutcome {
  itemId: string;
  /** Edit-distance similarity to the reference (`eval_results.score`), which also counts formatting. */
  baselineScore: number;
  candidateScore: number;
  /** Formatting-blind word measures, present when the pairing was given the reference transcripts. */
  baselineWordRecall?: number;
  candidateWordRecall?: number;
  baselineWordPrecision?: number;
  candidateWordPrecision?: number;
}

function outputMarkdown(result: EvalResultRow): string | undefined {
  const markdown = (result.output as { markdown?: unknown } | null)?.markdown;
  return typeof markdown === 'string' ? markdown : undefined;
}

/** Pairs two transcription runs' per-slide scores on their shared, scored items. Callers pass rows
 * whose `score` has been computed against the current reference (`eval-compare` rescores stored
 * transcripts before pairing). With `referenceMarkdownByItemId`, each pair also carries the
 * formatting-blind word recall of both sides and the candidate's word precision, computed from the
 * stored outputs against that reference. */
export function extractTranscriptionPairedOutcomes(
  aResults: EvalResultRow[],
  bResults: EvalResultRow[],
  referenceMarkdownByItemId?: Map<string, string>,
): PairedTranscriptionOutcome[] {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  const outcomes: PairedTranscriptionOutcome[] = [];
  for (const [itemId, a] of aByItem) {
    const b = bByItem.get(itemId);
    if (a.score === null || !b || b.score === null) continue;
    const outcome: PairedTranscriptionOutcome = { itemId, baselineScore: a.score, candidateScore: b.score };
    const reference = referenceMarkdownByItemId?.get(itemId);
    const aMarkdown = outputMarkdown(a);
    const bMarkdown = outputMarkdown(b);
    if (reference !== undefined && aMarkdown !== undefined && bMarkdown !== undefined) {
      const baselineWords = scoreTranscriptionWords(reference, aMarkdown);
      const candidateWords = scoreTranscriptionWords(reference, bMarkdown);
      outcome.baselineWordRecall = baselineWords.wordRecall;
      outcome.baselineWordPrecision = baselineWords.wordPrecision;
      outcome.candidateWordRecall = candidateWords.wordRecall;
      outcome.candidateWordPrecision = candidateWords.wordPrecision;
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

export interface TranscriptionPairedComparisonResult {
  n: number;
  baselineMeanScore: number;
  candidateMeanScore: number;
  /** candidateMeanScore - baselineMeanScore. */
  diff: number;
  candidateBetter: number;
  baselineBetter: number;
  ties: number;
  /** Two-sided exact sign test over the non-tied items. */
  pValue: number;
  ci95: { lower: number; upper: number };
}

/** Paired comparison of two variants' per-slide scores: mean difference with a normal-approximation
 * 95% CI, the better/worse/tied split, and an exact two-sided sign test over the non-tied items —
 * the same shape as `pairedMappingComparison`, kept as its own named function since it pairs a
 * different metric on a different task. */
export function pairedTranscriptionComparison(outcomes: PairedTranscriptionOutcome[]): TranscriptionPairedComparisonResult {
  const n = outcomes.length;
  if (n === 0) {
    throw new Error('pairedTranscriptionComparison requires at least one item');
  }

  const diffs = outcomes.map((o) => o.candidateScore - o.baselineScore);
  const { mean: diff, ci95 } = meanAndCi95(diffs)!;
  const candidateBetter = diffs.filter((d) => d > 0).length;
  const baselineBetter = diffs.filter((d) => d < 0).length;
  const ties = n - candidateBetter - baselineBetter;

  return {
    n,
    baselineMeanScore: outcomes.reduce((a, o) => a + o.baselineScore, 0) / n,
    candidateMeanScore: outcomes.reduce((a, o) => a + o.candidateScore, 0) / n,
    diff,
    candidateBetter,
    baselineBetter,
    ties,
    pValue: signTestPValue(candidateBetter, baselineBetter),
    ci95,
  };
}

export interface TranscriptionRunStats {
  n: number;
  meanScore: number;
  scoreCi95: { lower: number; upper: number };
  worstScore: number;
  meanCoverage: number;
  costLatency: RunCostLatency;
}

/** One run's own transcription stats, read straight from its `eval_results` rows — independent of
 * reference or any other run, the same role `mappingRunStats` plays for mapping. */
export function transcriptionRunStats(results: EvalResultRow[]): TranscriptionRunStats {
  const scored = results.filter((r) => r.score !== null);
  const scoreValues = scored.map((r) => r.score!);
  const meanCi = meanAndCi95(scoreValues);
  const coverageValues = results
    .map((r) => (r.deterministic_checks as { coverage?: number } | null)?.coverage)
    .filter((v): v is number => v !== undefined);

  return {
    n: scored.length,
    meanScore: meanCi?.mean ?? NaN,
    scoreCi95: meanCi?.ci95 ?? { lower: NaN, upper: NaN },
    worstScore: scoreValues.length > 0 ? Math.min(...scoreValues) : NaN,
    meanCoverage: coverageValues.length > 0 ? coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length : NaN,
    costLatency: runCostLatency(results),
  };
}

function resultNoContentMarker(result: EvalResultRow | undefined): boolean | undefined {
  return (result?.deterministic_checks as { no_content_marker?: boolean } | null)?.no_content_marker;
}

export interface AgreementRate {
  n: number;
  agreementRate: number;
}

/** Whether a run's own no-content-marker flag (`deterministic_checks.no_content_marker`) matches
 * whether each item's reference transcript is itself the no-content marker — the transcription
 * task's "skipped-slide agreement". */
export function transcriptionNoContentAgreementVsReference(results: EvalResultRow[], referenceMarkdownByItemId: Map<string, string>): AgreementRate {
  let n = 0;
  let agree = 0;
  for (const r of results) {
    const referenceMarkdown = referenceMarkdownByItemId.get(r.item_id);
    const noContentMarker = resultNoContentMarker(r);
    if (referenceMarkdown === undefined || noContentMarker === undefined) continue;
    n++;
    if (noContentMarker === (referenceMarkdown.trim() === NO_CONTENT_MARKER)) agree++;
  }
  return { n, agreementRate: n > 0 ? agree / n : NaN };
}

/** Same agreement check as `transcriptionNoContentAgreementVsReference`, but between two runs' own
 * no-content-marker flags rather than against reference — the reference-free fallback's version of the same question. */
export function transcriptionNoContentAgreementBetweenRuns(aResults: EvalResultRow[], bResults: EvalResultRow[]): AgreementRate {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  let n = 0;
  let agree = 0;
  for (const [itemId, a] of aByItem) {
    const bNoContentMarker = resultNoContentMarker(bByItem.get(itemId));
    const aNoContentMarker = resultNoContentMarker(a);
    if (aNoContentMarker === undefined || bNoContentMarker === undefined) continue;
    n++;
    if (aNoContentMarker === bNoContentMarker) agree++;
  }
  return { n, agreementRate: n > 0 ? agree / n : NaN };
}

/** Whether a run's own stored table shape (`deterministic_checks.table_rows`/`table_cols`) matches
 * the table shape counted fresh off each item's reference markdown. */
export function transcriptionTableAgreementVsReference(results: EvalResultRow[], referenceMarkdownByItemId: Map<string, string>): AgreementRate {
  let n = 0;
  let agree = 0;
  for (const r of results) {
    const referenceMarkdown = referenceMarkdownByItemId.get(r.item_id);
    const checks = r.deterministic_checks as { table_rows?: number; table_cols?: number } | null;
    if (referenceMarkdown === undefined || !checks || checks.table_rows === undefined || checks.table_cols === undefined) continue;
    const referenceTable = countMarkdownTable(referenceMarkdown);
    n++;
    if (checks.table_rows === referenceTable.rows && checks.table_cols === referenceTable.cols) agree++;
  }
  return { n, agreementRate: n > 0 ? agree / n : NaN };
}

export interface TranscriptionNonInferiorityVerdict {
  nonInferior: boolean;
  reason: string;
}

/**
 * The transcription task's non-inferiority verdict. When every paired outcome carries the word
 * measures (the pairing was given the reference transcripts), the checks run on words captured,
 * which is blind to whether a model chose a table or a list: the candidate's mean word recall over
 * the paired slides must be within `TASK_TOLERANCES.transcription.tolerance` of the baseline's, and
 * on no slide may the candidate fall more than `TRANSCRIPTION_MAX_SLIDE_DROP` below the baseline's
 * word recall (content lost) or the baseline's word precision (content added that is not on the
 * slide) on that same slide. Both per-slide checks are relative to the baseline, so a habit the
 * baseline shares (a bilingual heading the prompt asks for) is not held against a candidate, while
 * padding a slide the baseline transcribed cleanly is. Without the word measures the same mean and
 * recall-drop shapes run on the edit-distance score, with no precision check. In
 * both modes the per-slide checks only consider `pairedOutcomes` (slides scored in both runs), a
 * slide missing from either run is excluded rather than counted as a drop, and empty
 * `pairedOutcomes` fails outright: no overlap is no evidence of non-inferiority. No-content
 * agreement must be perfect whenever there is at least one reference item to check it against.
 */
export function transcriptionNonInferiorityVerdict(
  baselineStats: TranscriptionRunStats,
  candidateStats: TranscriptionRunStats,
  pairedOutcomes: PairedTranscriptionOutcome[],
  noContentAgreement: AgreementRate,
): TranscriptionNonInferiorityVerdict {
  const tolerance = TASK_TOLERANCES.transcription;
  const onWords = pairedOutcomes.length > 0 && pairedOutcomes.every(
    (o) => o.baselineWordRecall !== undefined && o.candidateWordRecall !== undefined
      && o.baselineWordPrecision !== undefined && o.candidateWordPrecision !== undefined,
  );
  const measure = onWords ? 'word recall' : 'score';
  const baselineOf = (o: PairedTranscriptionOutcome) => (onWords ? o.baselineWordRecall! : o.baselineScore);
  const candidateOf = (o: PairedTranscriptionOutcome) => (onWords ? o.candidateWordRecall! : o.candidateScore);

  const baselineMean = onWords
    ? pairedOutcomes.reduce((a, o) => a + o.baselineWordRecall!, 0) / pairedOutcomes.length
    : baselineStats.meanScore;
  const candidateMean = onWords
    ? pairedOutcomes.reduce((a, o) => a + o.candidateWordRecall!, 0) / pairedOutcomes.length
    : candidateStats.meanScore;
  const meanFloor = baselineMean - tolerance.tolerance;
  const meanOk = candidateMean >= meanFloor;

  let worstDrop = -Infinity;
  let worstDropItemId = '';
  let worstPrecisionDrop = -Infinity;
  let worstPrecisionDropItemId = '';
  for (const o of pairedOutcomes) {
    const drop = baselineOf(o) - candidateOf(o);
    if (drop > worstDrop) {
      worstDrop = drop;
      worstDropItemId = o.itemId;
    }
    if (onWords) {
      const precisionDrop = o.baselineWordPrecision! - o.candidateWordPrecision!;
      if (precisionDrop > worstPrecisionDrop) {
        worstPrecisionDrop = precisionDrop;
        worstPrecisionDropItemId = o.itemId;
      }
    }
  }
  const worstOk = pairedOutcomes.length > 0 && worstDrop <= TRANSCRIPTION_MAX_SLIDE_DROP;
  const precisionOk = !onWords || worstPrecisionDrop <= TRANSCRIPTION_MAX_SLIDE_DROP;

  const noContentOk = noContentAgreement.n === 0 || noContentAgreement.agreementRate === 1;
  const noContentAgreeCount = Math.round(noContentAgreement.agreementRate * noContentAgreement.n);

  return {
    nonInferior: meanOk && worstOk && precisionOk && noContentOk,
    reason: `mean ${measure} ${candidateMean.toFixed(4)} ${meanOk ? '>=' : '<'} ${meanFloor.toFixed(4)} `
      + `(baseline ${baselineMean.toFixed(4)}, tolerance ${tolerance.tolerance}); `
      + (pairedOutcomes.length === 0
        ? 'no slides scored in both runs'
        : `largest ${onWords ? 'word recall drop' : 'drop'} ${worstDrop.toFixed(4)} on item ${worstDropItemId} (limit ${TRANSCRIPTION_MAX_SLIDE_DROP}), `
          + `${pairedOutcomes.length} slide${pairedOutcomes.length === 1 ? '' : 's'} compared`)
      + (onWords
        ? `; largest word precision drop ${worstPrecisionDrop.toFixed(4)} on item ${worstPrecisionDropItemId} (limit ${TRANSCRIPTION_MAX_SLIDE_DROP})`
        : '')
      + '; '
      + (noContentAgreement.n === 0
        ? 'no-content agreement n/a (no reference items)'
        : `no-content agreement ${noContentAgreeCount}/${noContentAgreement.n}`),
  };
}

export interface TranscriptionVariantComparison {
  candidateRunId: string;
  candidateModel: string;
  candidateStats: TranscriptionRunStats;
  paired: TranscriptionPairedComparisonResult;
  noContentAgreement: AgreementRate;
  tableAgreement: AgreementRate;
  verdict: TranscriptionNonInferiorityVerdict;
}

export interface TranscriptionNoiseFloorEntry {
  model: string;
  runIds: [string, string];
  n: number;
  meanAbsDiff: number;
}

/**
 * Renders the transcription task's reference-backed comparison report: each candidate's own stats
 * (mean score with a 95% CI, worst slide, mean text coverage, no-content and table-structure agreement
 * with reference, cost and latency) next to the baseline's, a paired test on the per-slide score
 * difference, and the noise floor from any repeats.
 */
export function buildTranscriptionCompareMarkdown(params: {
  setId: string;
  baselineRunId: string;
  baselineModel: string;
  baselineStats: TranscriptionRunStats;
  baselineNoContentAgreement: AgreementRate;
  baselineTableAgreement: AgreementRate;
  variants: TranscriptionVariantComparison[];
  noiseFloors: TranscriptionNoiseFloorEntry[];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Eval compare — transcription — set ${params.setId}`);
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Baseline: run ${params.baselineRunId} (${params.baselineModel})`);
  lines.push('');
  lines.push('## Per-run stats (against reference)');
  lines.push('');
  lines.push('| Run | n | Mean score | 95% CI | Worst | Mean coverage | No-content agreement | Table agreement | Cost/item | Latency p50 | Latency p95 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const statsRow = (label: string, stats: TranscriptionRunStats, noContentAgreement: AgreementRate, table: AgreementRate) =>
    `| ${label} | ${stats.n} | ${formatOrNA(stats.meanScore, 4)} | [${formatOrNA(stats.scoreCi95.lower, 4)}, ${formatOrNA(stats.scoreCi95.upper, 4)}] | ${formatOrNA(stats.worstScore, 4)} | ${formatOrNA(stats.meanCoverage, 4)} | ${formatOrNA(noContentAgreement.agreementRate, 4)} | ${formatOrNA(table.agreementRate, 4)} | ${formatOrNA(stats.costLatency.costPerItemUsd, 6, { prefix: '$' })} | ${formatOrNA(stats.costLatency.latencyMsP50, 0, { suffix: 'ms' })} | ${formatOrNA(stats.costLatency.latencyMsP95, 0, { suffix: 'ms' })} |`;
  lines.push(statsRow(`${params.baselineModel} (run ${params.baselineRunId}, baseline)`, params.baselineStats, params.baselineNoContentAgreement, params.baselineTableAgreement));
  for (const v of params.variants) {
    lines.push(statsRow(`${v.candidateModel} (run ${v.candidateRunId})`, v.candidateStats, v.noContentAgreement, v.tableAgreement));
  }

  lines.push('');
  lines.push('## Paired comparison against baseline');
  lines.push('');
  lines.push('| Candidate | n | Baseline mean | Candidate mean | Diff | Better / worse / tied | Sign-test p | 95% CI |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const v of params.variants) {
    const p = v.paired;
    lines.push(`| ${v.candidateModel} (run ${v.candidateRunId}) | ${p.n} | ${formatOrNA(p.baselineMeanScore, 4)} | ${formatOrNA(p.candidateMeanScore, 4)} | ${p.diff >= 0 ? '+' : ''}${p.diff.toFixed(4)} | ${p.candidateBetter} / ${p.baselineBetter} / ${p.ties} | ${p.pValue.toFixed(4)} | [${p.ci95.lower.toFixed(4)}, ${p.ci95.upper.toFixed(4)}] |`);
  }

  lines.push('');
  lines.push('## Non-inferiority verdict');
  lines.push('');
  for (const v of params.variants) {
    lines.push(`- ${v.candidateModel} (run ${v.candidateRunId}): **${v.verdict.nonInferior ? 'non-inferior' : 'NOT non-inferior'}** — ${v.verdict.reason}`);
  }

  lines.push(...buildNoiseFloorSection(
    params.noiseFloors,
    ['Model', 'Runs', 'n', 'Mean |score diff|'],
    (nf) => `| ${nf.model} | ${nf.runIds.join(', ')} | ${nf.n} | ${formatOrNA(nf.meanAbsDiff, 4)} |`,
  ));

  return lines.join('\n') + '\n';
}

export interface TranscriptionReferenceFreeVariantComparison {
  candidateRunId: string;
  candidateModel: string;
  /** Mean/CI of the per-slide similarity between the candidate's and the baseline's own output —
   * agreement, not accuracy: there is no reference to be accurate against yet. */
  agreement: MeanAndCi95Result;
  n: number;
  noContentAgreement: AgreementRate;
  candidateCostLatency: RunCostLatency;
}

interface MeanAndCi95Result {
  mean: number;
  ci95: { lower: number; upper: number };
}

/** Per-slide similarity (`scoreTranscription`) between two runs' own outputs, on their shared items
 * that both produced output for — the reference-free analogue of `extractTranscriptionPairedOutcomes`. */
export function extractTranscriptionAgreementScores(aResults: EvalResultRow[], bResults: EvalResultRow[]): number[] {
  const aByItem = resultByItem(aResults);
  const bByItem = resultByItem(bResults);
  const scores: number[] = [];
  for (const [itemId, a] of aByItem) {
    const b = bByItem.get(itemId);
    const aMarkdown = (a.output as { markdown?: string } | null)?.markdown;
    const bMarkdown = (b?.output as { markdown?: string } | null)?.markdown;
    if (aMarkdown === undefined || bMarkdown === undefined) continue;
    scores.push(scoreTranscription(aMarkdown, bMarkdown));
  }
  return scores;
}

const NO_REFERENCE_LABEL_TRANSCRIPTION = 'no approved reference yet: agreement with the baseline transcript only, not an accuracy figure';

/**
 * Renders the transcription task's reference-free report: per-slide similarity between each
 * candidate's and the baseline's own output, no-content agreement between the two runs, and cost and
 * latency per run. No score against reference anywhere in this report — there is none yet.
 */
export function buildTranscriptionReferenceFreeCompareMarkdown(params: {
  setId: string;
  baselineRunId: string;
  baselineModel: string;
  baselineCostLatency: RunCostLatency;
  variants: TranscriptionReferenceFreeVariantComparison[];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Eval compare — transcription — set ${params.setId}`);
  lines.push('');
  lines.push(`**${NO_REFERENCE_LABEL_TRANSCRIPTION}**`);
  lines.push('');
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push(`Baseline: run ${params.baselineRunId} (${params.baselineModel})`);
  lines.push('');
  lines.push('## Agreement with baseline transcript');
  lines.push('');
  lines.push('| Candidate | n | Mean agreement | 95% CI | No-content agreement |');
  lines.push('|---|---|---|---|---|');
  for (const v of params.variants) {
    lines.push(`| ${v.candidateModel} (run ${v.candidateRunId}) | ${v.n} | ${formatOrNA(v.agreement.mean, 4)} | [${formatOrNA(v.agreement.ci95.lower, 4)}, ${formatOrNA(v.agreement.ci95.upper, 4)}] | ${formatOrNA(v.noContentAgreement.agreementRate, 4)} |`);
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

  return lines.join('\n') + '\n';
}
