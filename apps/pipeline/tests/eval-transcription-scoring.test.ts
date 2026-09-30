import { describe, expect, it } from 'vitest';
import {
  normalizeTranscriptForScoring,
  levenshteinDistance,
  normalizedEditDistance,
  scoreTranscription,
  countMarkdownTable,
  computeTranscriptionDeterministicChecks,
  buildTranscriptionRunSummary,
  NO_CONTENT_MARKER,
  type TranscriptionItemOutcome,
} from '../src/lib/eval/transcription-scoring';

describe('normalizeTranscriptForScoring', () => {
  it('unifies line endings and collapses whitespace runs to a single space', () => {
    expect(normalizeTranscriptForScoring('a\r\nb\n\n  c   d')).toBe('a b c d');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeTranscriptForScoring('  \n hello \n ')).toBe('hello');
  });

  it('never strips accents — accented orthography is exactly what the score checks', () => {
    expect(normalizeTranscriptForScoring('  Café Über Naïve Ångström  ')).toBe('Café Über Naïve Ångström');
  });
});

describe('levenshteinDistance', () => {
  it('is 0 for identical strings', () => {
    expect(levenshteinDistance('bonjour', 'bonjour')).toBe(0);
  });

  it('is the length of the longer string against an empty one', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('counts a single substitution as distance 1', () => {
    expect(levenshteinDistance('chat', 'chas')).toBe(1);
  });

  it('is accent-sensitive: an accent difference counts as an edit', () => {
    expect(levenshteinDistance('eleve', 'élève')).toBe(2);
  });

  it('counts insertions and deletions', () => {
    expect(levenshteinDistance('abc', 'abcde')).toBe(2);
    expect(levenshteinDistance('abcde', 'abc')).toBe(2);
  });
});

describe('normalizedEditDistance', () => {
  it('is 0 for two empty strings (a perfect match, not a division by zero)', () => {
    expect(normalizedEditDistance('', '')).toBe(0);
  });

  it('is 0 for identical strings', () => {
    expect(normalizedEditDistance('bonjour', 'bonjour')).toBe(0);
  });

  it('is bounded at 1 for a completely disjoint pair', () => {
    expect(normalizedEditDistance('aaa', 'bbbb')).toBe(1);
  });

  it('divides by the longer string\'s length', () => {
    // "chat" -> "chats": 1 insertion, longer length 5.
    expect(normalizedEditDistance('chat', 'chats')).toBeCloseTo(1 / 5, 10);
  });
});

describe('scoreTranscription', () => {
  it('scores an exact match as 1', () => {
    expect(scoreTranscription('## Les animaux\n\nLe chat', '## Les animaux\n\nLe chat')).toBe(1);
  });

  it('scores a match that differs only in whitespace/line breaks as 1 (normalization ignores it)', () => {
    expect(scoreTranscription('## Les animaux\n\nLe chat', '##   Les animaux\nLe chat')).toBe(1);
  });

  it('penalizes a missing accent', () => {
    const score = scoreTranscription('Les élèves étudient', 'Les eleves etudient');
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores completely wrong content near 0', () => {
    const score = scoreTranscription('Les élèves étudient le français', 'xyz completely unrelated qqq');
    expect(score).toBeLessThan(0.3);
  });
});

describe('countMarkdownTable', () => {
  it('returns zero rows and cols when there is no table', () => {
    expect(countMarkdownTable('## Heading\n\nSome plain text.')).toEqual({ rows: 0, cols: 0 });
  });

  it('counts a simple table\'s data rows and columns', () => {
    const md = [
      '| Subject | -er verb |',
      '|---|---|',
      '| je | parle |',
      '| tu | parles |',
    ].join('\n');
    expect(countMarkdownTable(md)).toEqual({ rows: 2, cols: 2 });
  });

  it('picks the widest table when more than one is present', () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '| A | B | C |',
      '|---|---|---|',
      '| 1 | 2 | 3 |',
      '| 4 | 5 | 6 |',
    ].join('\n');
    expect(countMarkdownTable(md)).toEqual({ rows: 2, cols: 3 });
  });

  it('does not treat a header-only block (no separator row) as a table', () => {
    const md = '| Subject | Verb |\n| je | parle |';
    expect(countMarkdownTable(md)).toEqual({ rows: 0, cols: 0 });
  });
});

describe('computeTranscriptionDeterministicChecks', () => {
  it('detects the exact no-content marker', () => {
    const result = computeTranscriptionDeterministicChecks('some slide text', NO_CONTENT_MARKER);
    expect(result.noContentMarker).toBe(true);
  });

  it('does not flag ordinary content as the no-content marker', () => {
    const result = computeTranscriptionDeterministicChecks('some slide text', '## Heading\n\nContent');
    expect(result.noContentMarker).toBe(false);
  });

  it('computes coverage against the slide text layer', () => {
    const result = computeTranscriptionDeterministicChecks('les dates importantes', '## Dates');
    expect(result.coverage).toBeLessThan(1);
  });

  it('reports chars as the output\'s length', () => {
    const result = computeTranscriptionDeterministicChecks('', 'abcde');
    expect(result.chars).toBe(5);
  });

  it('reports table shape from the output', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = computeTranscriptionDeterministicChecks('', md);
    expect(result.tableRows).toBe(1);
    expect(result.tableCols).toBe(2);
  });
});

describe('buildTranscriptionRunSummary', () => {
  function outcome(overrides: Partial<TranscriptionItemOutcome> = {}): TranscriptionItemOutcome {
    return {
      itemId: `item-${Math.random()}`,
      slide: 1,
      category: 'text',
      slideText: 'les chats',
      reference: 'Les chats',
      output: 'Les chats',
      score: 1,
      deterministicChecks: { coverage: 1, noContentMarker: false, tableRows: 0, tableCols: 0, chars: 9 },
      latencyMs: 100,
      costUsd: 0.001,
      ...overrides,
    };
  }

  it('computes mean score and a 95% CI over scored items', () => {
    const outcomes = [outcome({ score: 1 }), outcome({ score: 0 })];
    const summary = buildTranscriptionRunSummary(outcomes);
    expect(summary.meanScore).toBeCloseTo(0.5, 10);
    expect(summary.scoreCi95).toBeDefined();
  });

  it('reports the worst score', () => {
    const outcomes = [outcome({ score: 0.9 }), outcome({ score: 0.4 }), outcome({ score: 1 })];
    expect(buildTranscriptionRunSummary(outcomes).worstScore).toBe(0.4);
  });

  it('reports the no-content marker rate among items with output', () => {
    const outcomes = [
      outcome({ deterministicChecks: { coverage: 1, noContentMarker: true, tableRows: 0, tableCols: 0, chars: 30 } }),
      outcome({ deterministicChecks: { coverage: 1, noContentMarker: false, tableRows: 0, tableCols: 0, chars: 9 } }),
    ];
    expect(buildTranscriptionRunSummary(outcomes).noContentMarkerRate).toBeCloseTo(0.5, 10);
  });

  it('breaks scores down by category', () => {
    const outcomes = [
      outcome({ category: 'image-dominated', score: 0.2 }),
      outcome({ category: 'text', score: 1 }),
      outcome({ category: 'mixed', score: 0.6 }),
    ];
    const summary = buildTranscriptionRunSummary(outcomes);
    expect(summary.byCategory['image-dominated'].meanScore).toBeCloseTo(0.2, 10);
    expect(summary.byCategory.text.meanScore).toBe(1);
    expect(summary.byCategory.mixed.meanScore).toBeCloseTo(0.6, 10);
  });

  it('counts a pending-reference item toward referenceItemCount only when reference is present', () => {
    const outcomes = [outcome({ reference: undefined, score: undefined }), outcome()];
    expect(buildTranscriptionRunSummary(outcomes).referenceItemCount).toBe(1);
  });

  it('excludes an errored item (no output) from the score mean', () => {
    const outcomes = [
      outcome(),
      outcome({ output: undefined, score: undefined, deterministicChecks: undefined, error: 'api' }),
    ];
    const summary = buildTranscriptionRunSummary(outcomes);
    expect(summary.meanScore).toBe(1); // only the one scored item counts
  });

  it('reports parseFailureRate from items whose error is specifically "parse"', () => {
    const outcomes = [
      outcome(),
      outcome({ output: undefined, score: undefined, deterministicChecks: undefined, error: 'parse' }),
    ];
    expect(buildTranscriptionRunSummary(outcomes).parseFailureRate).toBeCloseTo(0.5, 10);
  });

  it('returns undefined mean/CI for an empty outcome list rather than NaN', () => {
    const summary = buildTranscriptionRunSummary([]);
    expect(summary.meanScore).toBeUndefined();
    expect(summary.scoreCi95).toBeUndefined();
    expect(summary.worstScore).toBeUndefined();
    expect(summary.noContentMarkerRate).toBe(0);
  });
});
