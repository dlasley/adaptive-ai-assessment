/**
 * Per-run scoring for the transcription task (does a cheaper vision model transcribe
 * course slides into markdown as completely and accurately as production's model?). Mirrors
 * `mapping-scoring.ts`'s role for the mapping task: pure functions over already-fetched rows, no
 * Supabase or LLM calls.
 */

import { computeTextCoverage, NO_CONTENT_MARKER } from '../pdf-conversion';
import { percentile } from './runner';
import { meanAndCi95, type MeanCi95 } from './scoring';
import { TRANSCRIPTION_CATEGORIES, type TranscriptionCategory } from './set-builder';

export { computeTextCoverage, NO_CONTENT_MARKER };

/**
 * Normalizes a transcript for scoring: unifies line endings, then collapses every run of
 * whitespace (including newlines) to a single space and trims. This treats a slide's structural
 * formatting (line breaks, indentation, blank lines between sections) as immaterial to whether the
 * *content* was transcribed accurately, which is what the edit-distance score is measuring — a
 * word-for-word match reflowed onto different lines should not be penalized as if it were wrong.
 * Accents are never touched: accented orthography is exactly what this score is meant to catch
 * errors in.
 */
export function normalizeTranscriptForScoring(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

/** Classic Wagner-Fischer edit distance, single-row DP (O(n) memory, O(n*m) time) — slide transcripts
 * are at most a few thousand characters, so the quadratic time is not a concern. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow.push(Math.min(
        previousRow[j] + 1, // deletion
        currentRow[j - 1] + 1, // insertion
        previousRow[j - 1] + cost, // substitution
      ));
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/** Edit distance divided by the longer string's length — 0 for an exact match, bounded at 1 (a
 * completely disjoint pair of non-empty strings costs exactly `max(len)` edits). Two empty strings
 * are a perfect match (distance 0), not a division by zero. */
export function normalizedEditDistance(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 0;
  return levenshteinDistance(a, b) / Math.max(a.length, b.length);
}

/** `1 - normalizedEditDistance` on the normalized text — a similarity score in [0, 1], higher is
 * better, the same convention `eval_results.score` uses for the mapping task's F1. */
export function scoreTranscription(reference: string, output: string): number {
  return 1 - normalizedEditDistance(normalizeTranscriptForScoring(reference), normalizeTranscriptForScoring(output));
}

export interface MarkdownTableShape {
  rows: number;
  cols: number;
}

const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

function tableRowCells(line: string): string[] {
  const match = line.match(TABLE_ROW_RE);
  const inner = match ? match[1] : line.replace(/^\||\|$/g, '');
  return inner.split('|');
}

/**
 * Counts the widest markdown table's data rows and column count. A table is a header row
 * immediately followed by a `---`-style separator row (GitHub-flavored markdown's table syntax);
 * "widest" means most columns, ties broken by the first such table in the document. `rows` counts
 * only data rows — the header and separator are structure, not content, and reference/output should
 * agree on how many data rows a table has regardless of a header wording difference. Returns
 * `{ rows: 0, cols: 0 }` when the text has no table at all.
 */
export function countMarkdownTable(markdown: string): MarkdownTableShape {
  const lines = markdown.split('\n');
  let best: MarkdownTableShape = { rows: 0, cols: 0 };

  for (let i = 0; i < lines.length - 1; i++) {
    if (!TABLE_ROW_RE.test(lines[i]) || !TABLE_SEPARATOR_RE.test(lines[i + 1]) || !lines[i + 1].includes('-')) {
      continue;
    }
    const cols = tableRowCells(lines[i]).length;
    let rows = 0;
    let j = i + 2;
    while (j < lines.length && TABLE_ROW_RE.test(lines[j])) {
      rows++;
      j++;
    }
    if (cols > best.cols) best = { rows, cols };
    i = j - 1; // skip past this table
  }

  return best;
}

export interface TranscriptionDeterministicChecks {
  /** `computeTextCoverage` of the output against this slide's own text layer — the same coverage
   * check production's conversion report flags on. */
  coverage: number;
  /** Whether the output is exactly `NO_CONTENT_MARKER`. */
  noContentMarker: boolean;
  tableRows: number;
  tableCols: number;
  chars: number;
}

export function computeTranscriptionDeterministicChecks(slideText: string, output: string): TranscriptionDeterministicChecks {
  const table = countMarkdownTable(output);
  return {
    coverage: computeTextCoverage(slideText, output),
    noContentMarker: output.trim() === NO_CONTENT_MARKER,
    tableRows: table.rows,
    tableCols: table.cols,
    chars: output.length,
  };
}

export interface TranscriptionItemOutcome {
  itemId: string;
  slide: number;
  category: TranscriptionCategory;
  slideText: string;
  /** The checked transcript, when this item's reference is approved; undefined while pending. */
  reference?: string;
  /** This variant's cleaned markdown output, or undefined when the call errored. */
  output?: string;
  score?: number;
  deterministicChecks?: TranscriptionDeterministicChecks;
  /** Only 'api' and 'empty' occur for this task: the output is raw Markdown with no parse step.
   * The union matches the other tasks so the shared summary helpers apply unchanged. */
  error?: 'parse' | 'api' | 'empty';
  latencyMs?: number;
  costUsd?: number;
}

interface CategoryBucket {
  n: number;
  meanScore: number | undefined;
}

export interface TranscriptionRunSummary {
  itemCount: number;
  referenceItemCount: number;
  meanScore: number | undefined;
  scoreCi95: MeanCi95['ci95'] | undefined;
  worstScore: number | undefined;
  meanCoverage: number | undefined;
  /** Fraction of items (with output) whose output was exactly the no-content marker — this run's
   * own rate, not an agreement figure (that's `eval-compare`'s job, paired against reference or baseline). */
  noContentMarkerRate: number;
  parseFailureRate: number;
  latencyMsP50: number | undefined;
  latencyMsP95: number | undefined;
  costPerItemUsd: number | undefined;
  byCategory: Record<TranscriptionCategory, CategoryBucket>;
}

export function buildTranscriptionRunSummary(outcomes: TranscriptionItemOutcome[]): TranscriptionRunSummary {
  const itemCount = outcomes.length;
  const referenceItemCount = outcomes.filter((o) => o.reference !== undefined).length;
  const scored = outcomes.filter((o) => o.score !== undefined);
  const scoreValues = scored.map((o) => o.score!);
  const meanCi = meanAndCi95(scoreValues);
  const withOutput = outcomes.filter((o) => o.output !== undefined);
  const coverageValues = outcomes.map((o) => o.deterministicChecks?.coverage).filter((v): v is number => v !== undefined);
  const parseFailures = outcomes.filter((o) => o.error === 'parse').length;
  const latencies = outcomes.map((o) => o.latencyMs).filter((v): v is number => v !== undefined);
  const costs = outcomes.map((o) => o.costUsd).filter((v): v is number => v !== undefined);

  const byCategory = Object.fromEntries(TRANSCRIPTION_CATEGORIES.map((category) => {
    const inCategory = scored.filter((o) => o.category === category);
    const categoryMean = meanAndCi95(inCategory.map((o) => o.score!));
    return [category, { n: inCategory.length, meanScore: categoryMean?.mean }];
  })) as Record<TranscriptionCategory, CategoryBucket>;

  return {
    itemCount,
    referenceItemCount,
    meanScore: meanCi?.mean,
    scoreCi95: meanCi?.ci95,
    worstScore: scoreValues.length > 0 ? Math.min(...scoreValues) : undefined,
    meanCoverage: coverageValues.length > 0 ? coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length : undefined,
    noContentMarkerRate: withOutput.length > 0
      ? withOutput.filter((o) => o.deterministicChecks?.noContentMarker).length / withOutput.length
      : 0,
    parseFailureRate: itemCount > 0 ? parseFailures / itemCount : 0,
    latencyMsP50: percentile(latencies, 50),
    latencyMsP95: percentile(latencies, 95),
    costPerItemUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / itemCount : undefined,
    byCategory,
  };
}
