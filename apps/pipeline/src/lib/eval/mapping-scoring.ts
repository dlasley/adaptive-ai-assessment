/**
 * Per-run scoring for the mapping task (does a cheaper model map a unit's topic names to
 * the same verbatim document headings as the production model?). Mirrors `runner.ts`'s role for
 * audit/grading: pure functions over already-fetched rows, no Supabase or LLM calls.
 *
 * A heading is normalized for scoring to `{ text, slide }`: `text` is `normalizeHeadingText`'d (case
 * and whitespace folded), and `slide` is the ref's slide when it carries one (a `{ heading, slide }`
 * pair) or null when it doesn't (a bare string, which is only ever stored for heading text that's
 * unique in the document). Two normalized headings match when their text is equal and, whenever the
 * reference side carries a slide, the candidate's slide equals it too — reference's slide is only null when the
 * production heading was stored as a bare string, i.e. the text alone was already unambiguous.
 */

import {
  normalizeHeadingText,
  toHeadingSlideForm,
  findHeadingMismatches,
  formatHeadingRef,
  collapseNestedHeadings,
  type HeadingRef,
  type DocumentHeadingOccurrence,
} from '../learning-materials';
import { percentile } from './runner';
import { meanAndCi95, type MeanCi95 } from './scoring';

export interface NormalizedHeading {
  text: string;
  slide: number | null;
}

export function normalizeHeadingForScoring(ref: HeadingRef): NormalizedHeading {
  const { heading, slide } = toHeadingSlideForm(ref);
  return { text: normalizeHeadingText(heading), slide };
}

function headingsMatch(reference: NormalizedHeading, candidate: NormalizedHeading): boolean {
  if (reference.text !== candidate.text) return false;
  if (reference.slide === null) return true;
  return candidate.slide === reference.slide;
}

export interface HeadingSetF1 {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
}

/**
 * Precision/recall/F1 between a reference heading set and a candidate's returned headings, matched
 * greedily (each candidate heading consumes at most one unmatched reference heading). Both empty scores
 * a perfect 1 — there was nothing to find and nothing was wrongly returned; one side empty and the
 * other not scores 0, since either every returned heading is a false positive or every reference heading
 * was missed.
 */
export function headingSetF1(reference: HeadingRef[], candidate: HeadingRef[]): HeadingSetF1 {
  const referenceNorm = reference.map(normalizeHeadingForScoring);
  const candidateNorm = candidate.map(normalizeHeadingForScoring);

  if (referenceNorm.length === 0 && candidateNorm.length === 0) {
    return { precision: 1, recall: 1, f1: 1, truePositives: 0 };
  }

  const consumed = new Array(referenceNorm.length).fill(false);
  let truePositives = 0;
  for (const c of candidateNorm) {
    const idx = referenceNorm.findIndex((r, i) => !consumed[i] && headingsMatch(r, c));
    if (idx !== -1) {
      consumed[idx] = true;
      truePositives++;
    }
  }

  const precision = candidateNorm.length > 0 ? truePositives / candidateNorm.length : 1;
  const recall = referenceNorm.length > 0 ? truePositives / referenceNorm.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, truePositives };
}

export interface MappingDeterministicChecks {
  resolved: number;
  unresolved: number;
  unresolvedHeadings: string[];
  nestedDuplicates: number;
}

/**
 * Deterministic checks on one topic's raw returned headings against the document: how many resolve
 * to exactly one section (`findHeadingMismatches`, the same validator production's retry loop
 * uses), and how many are covered by another heading in the same list (`collapseNestedHeadings`'s
 * `collapsedCount`, computed here on the uncollapsed list — the eval runner never applies the
 * collapse itself, so this counts what the raw call actually returned).
 */
export function computeMappingDeterministicChecks(
  topic: string,
  headings: HeadingRef[],
  documentHeadings: DocumentHeadingOccurrence[],
): MappingDeterministicChecks {
  const mismatches = findHeadingMismatches([{ name: topic, headings }], documentHeadings);
  const nestedDuplicates = collapseNestedHeadings(headings, documentHeadings).collapsedCount;
  return {
    resolved: headings.length - mismatches.length,
    unresolved: mismatches.length,
    unresolvedHeadings: mismatches.map((m) => formatHeadingRef(m.heading)),
    nestedDuplicates,
  };
}

export interface MappingItemOutcome {
  itemId: string;
  topic: string;
  reference: HeadingRef[];
  /** This variant's returned headings for the topic, or undefined when the call errored. */
  output?: HeadingRef[];
  scoring?: HeadingSetF1;
  deterministicChecks?: MappingDeterministicChecks;
  error?: 'parse' | 'api' | 'empty';
  latencyMs?: number;
  costUsd?: number;
}

export interface MappingRunSummary {
  itemCount: number;
  meanF1: number | undefined;
  f1Ci95: MeanCi95['ci95'] | undefined;
  fractionF1Perfect: number;
  totalUnresolved: number;
  totalNestedDuplicates: number;
  parseFailureRate: number;
  latencyMsP50: number | undefined;
  latencyMsP95: number | undefined;
  costPerItemUsd: number | undefined;
}

export function buildMappingRunSummary(outcomes: MappingItemOutcome[]): MappingRunSummary {
  const itemCount = outcomes.length;
  const scored = outcomes.filter((o) => o.scoring !== undefined);
  const f1Values = scored.map((o) => o.scoring!.f1);
  const meanCi = meanAndCi95(f1Values);
  const parseFailures = outcomes.filter((o) => o.error === 'parse').length;
  const latencies = outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== undefined);
  const costs = outcomes.map((o) => o.costUsd).filter((v): v is number => v !== undefined);

  return {
    itemCount,
    meanF1: meanCi?.mean,
    f1Ci95: meanCi?.ci95,
    fractionF1Perfect: scored.length > 0 ? scored.filter((o) => o.scoring!.f1 === 1).length / scored.length : 0,
    totalUnresolved: outcomes.reduce((sum, o) => sum + (o.deterministicChecks?.unresolved ?? 0), 0),
    totalNestedDuplicates: outcomes.reduce((sum, o) => sum + (o.deterministicChecks?.nestedDuplicates ?? 0), 0),
    parseFailureRate: itemCount > 0 ? parseFailures / itemCount : 0,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    costPerItemUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / itemCount : undefined,
  };
}
