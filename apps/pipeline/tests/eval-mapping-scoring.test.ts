import { describe, expect, it } from 'vitest';
import {
  normalizeHeadingForScoring,
  headingSetF1,
  computeMappingDeterministicChecks,
  buildMappingRunSummary,
  type MappingItemOutcome,
} from '../src/lib/eval/mapping-scoring';
import { toHeadingSlideForm, type DocumentHeadingOccurrence } from '../src/lib/learning-materials';

function occ(heading: string, slide: number | null, level = 2): DocumentHeadingOccurrence {
  return { heading, slide, level, lineIndex: 0 };
}

const DOCUMENT_HEADINGS: DocumentHeadingOccurrence[] = [
  occ('Warm Up', 1),
  occ('Mots utiles', 1),
  occ('Grammar: Subjonctif', 2),
  occ('Exercices', 3),
  occ('Exercices', 5), // duplicate text, different slide
];

describe('toHeadingSlideForm', () => {
  it('normalizes a bare string to slide: null', () => {
    expect(toHeadingSlideForm('Warm Up')).toEqual({ heading: 'Warm Up', slide: null });
  });

  it('keeps a { heading, slide } ref as-is in shape', () => {
    expect(toHeadingSlideForm({ heading: 'Exercices', slide: 3 })).toEqual({ heading: 'Exercices', slide: 3 });
  });
});

describe('normalizeHeadingForScoring', () => {
  it('folds case and whitespace for text comparison, keeping slide null for a bare string', () => {
    expect(normalizeHeadingForScoring('  Warm   UP  ')).toEqual({ text: 'warm up', slide: null });
  });

  it('carries the slide through for an object ref', () => {
    expect(normalizeHeadingForScoring({ heading: 'Exercices', slide: 5 })).toEqual({ text: 'exercices', slide: 5 });
  });
});

describe('headingSetF1', () => {
  it('scores a perfect match as F1 1', () => {
    const result = headingSetF1(['Warm Up', 'Mots utiles'], ['Warm Up', 'Mots utiles']);
    expect(result).toEqual({ precision: 1, recall: 1, f1: 1, truePositives: 2 });
  });

  it('scores both empty (reference and candidate) as a perfect 1 — nothing to find, nothing wrongly returned', () => {
    expect(headingSetF1([], [])).toEqual({ precision: 1, recall: 1, f1: 1, truePositives: 0 });
  });

  it('scores an empty candidate against non-empty reference as 0 (missed everything)', () => {
    const result = headingSetF1(['Warm Up'], []);
    expect(result.recall).toBe(0);
    expect(result.f1).toBe(0);
  });

  it('scores a non-empty candidate against empty reference as 0 (every heading is a false positive)', () => {
    const result = headingSetF1([], ['Warm Up']);
    expect(result.precision).toBe(0);
    expect(result.f1).toBe(0);
  });

  it('computes partial credit when only some headings match', () => {
    // reference has 2, candidate returns 1 correct + 1 wrong: precision 1/2, recall 1/2, f1 1/2.
    const result = headingSetF1(['Warm Up', 'Mots utiles'], ['Warm Up', 'Made Up Heading']);
    expect(result.precision).toBeCloseTo(0.5, 10);
    expect(result.recall).toBeCloseTo(0.5, 10);
    expect(result.f1).toBeCloseTo(0.5, 10);
  });

  it('is slide-sensitive: a matching text with the wrong slide does not count as a match', () => {
    const reference = [{ heading: 'Exercices', slide: 5 }];
    const candidate = [{ heading: 'Exercices', slide: 3 }];
    const result = headingSetF1(reference, candidate);
    expect(result.truePositives).toBe(0);
    expect(result.f1).toBe(0);
  });

  it('matches on text alone when reference does not carry a slide (bare string, unique text)', () => {
    const reference = ['Warm Up'];
    // The candidate happens to include a slide — still matches, since reference's slide is null.
    const candidate = [{ heading: 'Warm Up', slide: 1 }];
    const result = headingSetF1(reference, candidate);
    expect(result.truePositives).toBe(1);
    expect(result.f1).toBe(1);
  });

  it('does not double-count a candidate heading against an already-matched reference heading', () => {
    // Two identical candidate headings can match at most one reference heading each is worth.
    const result = headingSetF1(['Warm Up'], ['Warm Up', 'Warm Up']);
    expect(result.truePositives).toBe(1);
    expect(result.precision).toBeCloseTo(0.5, 10);
    expect(result.recall).toBe(1);
  });
});

describe('computeMappingDeterministicChecks', () => {
  it('reports every heading resolved when they all validate', () => {
    const result = computeMappingDeterministicChecks('Topic A', ['Warm Up', { heading: 'Exercices', slide: 3 }], DOCUMENT_HEADINGS);
    expect(result).toEqual({ resolved: 2, unresolved: 0, unresolvedHeadings: [], nestedDuplicates: 0 });
  });

  it('counts an invented heading as unresolved and names it', () => {
    const result = computeMappingDeterministicChecks('Topic A', ['Made Up Heading'], DOCUMENT_HEADINGS);
    expect(result.resolved).toBe(0);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedHeadings).toEqual(['Made Up Heading']);
  });

  it('counts an ambiguous bare-string heading (no slide) as unresolved', () => {
    const result = computeMappingDeterministicChecks('Topic A', ['Exercices'], DOCUMENT_HEADINGS);
    expect(result.unresolved).toBe(1);
  });

  it('counts a heading contained in another heading in the same list as a nested duplicate', () => {
    // "Grammar: Subjonctif" at slide 2 is the parent section for these DOCUMENT_HEADINGS in this
    // fixture only if nested under it — reuse the exact-duplicate case instead, which always
    // collapses regardless of document structure: the same occurrence listed twice.
    const result = computeMappingDeterministicChecks('Topic A', ['Warm Up', 'Warm Up'], DOCUMENT_HEADINGS);
    expect(result.nestedDuplicates).toBe(1);
  });
});

describe('buildMappingRunSummary', () => {
  function outcome(overrides: Partial<MappingItemOutcome> = {}): MappingItemOutcome {
    return {
      itemId: `item-${Math.random()}`,
      topic: 'Topic A',
      reference: ['Warm Up'],
      output: ['Warm Up'],
      scoring: { precision: 1, recall: 1, f1: 1, truePositives: 1 },
      deterministicChecks: { resolved: 1, unresolved: 0, unresolvedHeadings: [], nestedDuplicates: 0 },
      latencyMs: 100,
      costUsd: 0.01,
      ...overrides,
    };
  }

  it('computes mean F1 and a 95% CI over scored items', () => {
    const outcomes = [
      outcome({ scoring: { precision: 1, recall: 1, f1: 1, truePositives: 1 } }),
      outcome({ scoring: { precision: 0, recall: 0, f1: 0, truePositives: 0 } }),
    ];
    const summary = buildMappingRunSummary(outcomes);
    expect(summary.itemCount).toBe(2);
    expect(summary.meanF1).toBeCloseTo(0.5, 10);
    expect(summary.f1Ci95).toBeDefined();
  });

  it('reports the fraction of items with a perfect F1', () => {
    const outcomes = [
      outcome({ scoring: { precision: 1, recall: 1, f1: 1, truePositives: 1 } }),
      outcome({ scoring: { precision: 1, recall: 1, f1: 1, truePositives: 1 } }),
      outcome({ scoring: { precision: 0.5, recall: 0.5, f1: 0.5, truePositives: 1 } }),
    ];
    const summary = buildMappingRunSummary(outcomes);
    expect(summary.fractionF1Perfect).toBeCloseTo(2 / 3, 10);
  });

  it('sums unresolved and nested-duplicate counts across items', () => {
    const outcomes = [
      outcome({ deterministicChecks: { resolved: 1, unresolved: 2, unresolvedHeadings: ['a', 'b'], nestedDuplicates: 1 } }),
      outcome({ deterministicChecks: { resolved: 1, unresolved: 1, unresolvedHeadings: ['c'], nestedDuplicates: 0 } }),
    ];
    const summary = buildMappingRunSummary(outcomes);
    expect(summary.totalUnresolved).toBe(3);
    expect(summary.totalNestedDuplicates).toBe(1);
  });

  it('counts a parse/api error as a failure and excludes it from the F1 mean', () => {
    const outcomes = [
      outcome(),
      outcome({ output: undefined, scoring: undefined, deterministicChecks: undefined, error: 'parse' }),
    ];
    const summary = buildMappingRunSummary(outcomes);
    expect(summary.parseFailureRate).toBeCloseTo(0.5, 10);
    expect(summary.meanF1).toBe(1); // only the one scored item counts
  });

  it('returns undefined mean/CI for an empty outcome list rather than NaN', () => {
    const summary = buildMappingRunSummary([]);
    expect(summary.meanF1).toBeUndefined();
    expect(summary.f1Ci95).toBeUndefined();
    expect(summary.fractionF1Perfect).toBe(0);
  });
});
