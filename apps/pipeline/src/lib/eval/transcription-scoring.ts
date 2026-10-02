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

export { NO_CONTENT_MARKER };

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

/**
 * The set of words in a transcript with markdown syntax removed: table pipes, emphasis, heading
 * marks, list dashes and colons become whitespace, a number standing alone with a trailing dot
 * (an ordered-list marker, "1. ") keeps its number and loses the dot so "1. B", "- 1. B" and
 * "- 1-B" yield the same words, then the text is lower-cased and split. Accents
 * survive, so an accent error is still a different word. Used for the formatting-blind
 * recall/precision pair, which asks whether the content was captured regardless of whether the
 * model chose a table, a list or a bold run to present it.
 */
export function wordSetForScoring(markdown: string): Set<string> {
  const words = markdown
    .replace(/[|*#_`>\-:]+/g, ' ')
    .replace(/(^|\s)(\d+)\.(?=\s|$)/g, '$1$2')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  return new Set(words);
}

export interface TranscriptionWordScores {
  /** Share of the reference's distinct words present in the output (completeness). */
  wordRecall: number;
  /** Share of the output's distinct words present in the reference (no additions). */
  wordPrecision: number;
}

/**
 * Formatting-blind companion to `scoreTranscription`. The no-content marker has no words, so a
 * pair that agrees on emptiness scores 1/1 and a pair where only one side is empty scores 0/0: a
 * wrong decision about whether a slide has content is a total miss in both directions.
 */
export function scoreTranscriptionWords(reference: string, output: string): TranscriptionWordScores {
  const referenceWords = wordSetForScoring(reference.trim() === NO_CONTENT_MARKER ? '' : reference);
  const outputWords = wordSetForScoring(output.trim() === NO_CONTENT_MARKER ? '' : output);
  if (referenceWords.size === 0 && outputWords.size === 0) return { wordRecall: 1, wordPrecision: 1 };
  if (referenceWords.size === 0 || outputWords.size === 0) return { wordRecall: 0, wordPrecision: 0 };
  let shared = 0;
  for (const w of referenceWords) if (outputWords.has(w)) shared++;
  return { wordRecall: shared / referenceWords.size, wordPrecision: shared / outputWords.size };
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
  /** 'parse' occurs only when an exclusion pass is active and its classifier call returns
   * malformed JSON; otherwise only 'api' and 'empty' occur, since the transcription output itself
   * is raw Markdown with no parse step. */
  error?: 'parse' | 'api' | 'empty';
  latencyMs?: number;
  costUsd?: number;
}

interface CategoryBucket {
  n: number;
  meanScore: number | undefined;
  meanWordRecall: number | undefined;
  meanWordPrecision: number | undefined;
}

function mean(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export interface TranscriptionRunSummary {
  itemCount: number;
  referenceItemCount: number;
  meanScore: number | undefined;
  scoreCi95: MeanCi95['ci95'] | undefined;
  worstScore: number | undefined;
  /** Formatting-blind completeness and no-additions means over the items with a reference and an
   * output; `meanScore` is the edit-distance similarity, which also counts formatting. */
  meanWordRecall: number | undefined;
  meanWordPrecision: number | undefined;
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

  const wordScored = outcomes
    .filter((o) => o.reference !== undefined && o.output !== undefined)
    .map((o) => ({ category: o.category, ...scoreTranscriptionWords(o.reference!, o.output!) }));

  const byCategory = Object.fromEntries(TRANSCRIPTION_CATEGORIES.map((category) => {
    const inCategory = scored.filter((o) => o.category === category);
    const categoryMean = meanAndCi95(inCategory.map((o) => o.score!));
    const wordsInCategory = wordScored.filter((w) => w.category === category);
    return [category, {
      n: inCategory.length,
      meanScore: categoryMean?.mean,
      meanWordRecall: mean(wordsInCategory.map((w) => w.wordRecall)),
      meanWordPrecision: mean(wordsInCategory.map((w) => w.wordPrecision)),
    }];
  })) as Record<TranscriptionCategory, CategoryBucket>;

  return {
    itemCount,
    referenceItemCount,
    meanScore: meanCi?.mean,
    scoreCi95: meanCi?.ci95,
    worstScore: scoreValues.length > 0 ? Math.min(...scoreValues) : undefined,
    meanWordRecall: mean(wordScored.map((w) => w.wordRecall)),
    meanWordPrecision: mean(wordScored.map((w) => w.wordPrecision)),
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
