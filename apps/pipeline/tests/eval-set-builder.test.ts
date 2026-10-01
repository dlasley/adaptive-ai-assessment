import { describe, expect, it } from 'vitest';
import {
  buildAuditItems,
  buildGradingItems,
  buildMappingItems,
  buildTranscriptionItems,
  categorizeTranscriptionSlides,
  drawTranscriptionSample,
  hashInputs,
  hashPdfBytes,
  strataKeyFn,
  excludeTopics,
  drawSelectionPool,
  GRADING_LABEL_CLASSES,
  type AuditSourceQuestion,
  type GradingSourceQuestion,
  type MappingSourceUnit,
  type TranscriptionConversionReport,
  type TranscriptionSlideInfo,
} from '../src/lib/eval/set-builder';

function makeAuditQuestion(overrides: Partial<AuditSourceQuestion> = {}): AuditSourceQuestion {
  return {
    id: `q-${Math.random()}`,
    question: 'q',
    correct_answer: 'a',
    type: 'multiple-choice',
    difficulty: 'beginner',
    topic: 'Slang',
    unit_id: 'unit-1',
    writing_type: null,
    options: null,
    acceptable_variations: null,
    quality_status: 'active',
    audit_metadata: null,
    ...overrides,
  };
}

describe('hashInputs', () => {
  it('is deterministic for the same markdown and units row', () => {
    expect(hashInputs('# md', { a: 1 })).toBe(hashInputs('# md', { a: 1 }));
  });

  it('differs when the markdown changes', () => {
    expect(hashInputs('# md v1', { a: 1 })).not.toBe(hashInputs('# md v2', { a: 1 }));
  });

  it('differs when the units row changes', () => {
    expect(hashInputs('# md', { a: 1 })).not.toBe(hashInputs('# md', { a: 2 }));
  });
});

describe('strataKeyFn', () => {
  it('joins named fields, coercing null to the string "null"', () => {
    const keyFn = strataKeyFn<{ type: string; difficulty: string | null }>(['type', 'difficulty']);
    expect(keyFn({ type: 'writing', difficulty: null })).toBe('writing|null');
    expect(keyFn({ type: 'writing', difficulty: 'beginner' })).toBe('writing|beginner');
  });
});

describe('buildAuditItems', () => {
  it('samples proportionally across type x difficulty when balanceStatus is not set', () => {
    const questions = [
      ...Array.from({ length: 20 }, () => makeAuditQuestion({ type: 'multiple-choice', difficulty: 'beginner' })),
      ...Array.from({ length: 10 }, () => makeAuditQuestion({ type: 'writing', difficulty: 'advanced' })),
    ];
    const result = buildAuditItems(questions, { size: 6, strata: ['type', 'difficulty'], seed: 1 });
    expect(result.items).toHaveLength(6);
    expect(result.strataCounts['multiple-choice|beginner']).toBe(4);
    expect(result.strataCounts['writing|advanced']).toBe(2);
  });

  it('snapshots the fields a runner needs, including the production audit verdict', () => {
    const q = makeAuditQuestion({
      id: 'q-1',
      audit_metadata: { gate_criteria: { answer_correct: true } },
    });
    const result = buildAuditItems([q], { size: 1, strata: ['type'], seed: 1 });
    expect(result.items[0].itemKey).toBe('q-1');
    expect(result.items[0].payload).toMatchObject({
      question: 'q',
      correct_answer: 'a',
      production_audit: { gate_criteria: { answer_correct: true } },
    });
  });

  it('splits flagged and non-flagged 50/50 when balanceStatus is set', () => {
    const questions = [
      ...Array.from({ length: 100 }, () => makeAuditQuestion({ quality_status: 'active' })),
      ...Array.from({ length: 10 }, () => makeAuditQuestion({ quality_status: 'flagged' })),
    ];
    const result = buildAuditItems(questions, { size: 10, strata: ['type'], seed: 1, balanceStatus: true });
    expect(result.items).toHaveLength(10);
    // 5 should come from the 10-item flagged pool and 5 from the 100-item active pool.
    const flaggedIds = new Set(questions.filter((q) => q.quality_status === 'flagged').map((q) => q.id));
    const drawnFromFlagged = result.items.filter((item) => flaggedIds.has(item.itemKey)).length;
    expect(drawnFromFlagged).toBe(5);
  });

  it('is deterministic given the same seed', () => {
    const questions = Array.from({ length: 30 }, (_, i) => makeAuditQuestion({ id: `q-${i}` }));
    const a = buildAuditItems(questions, { size: 10, strata: ['type'], seed: 7 });
    const b = buildAuditItems(questions, { size: 10, strata: ['type'], seed: 7 });
    expect(a.items.map((i) => i.itemKey)).toEqual(b.items.map((i) => i.itemKey));
  });
});

describe('excludeTopics', () => {
  it('removes items whose topic exactly matches an excluded name', () => {
    const items = [
      makeAuditQuestion({ id: 'a', topic: 'Slang' }),
      makeAuditQuestion({ id: 'b', topic: 'Greetings' }),
      makeAuditQuestion({ id: 'c', topic: 'Slang' }),
    ];
    const result = excludeTopics(items, new Set(['Slang']));
    expect(result.map((i) => i.id)).toEqual(['b']);
  });

  it('is a no-op when no topic matches', () => {
    const items = [makeAuditQuestion({ id: 'a', topic: 'Greetings' })];
    expect(excludeTopics(items, new Set(['Slang']))).toEqual(items);
  });
});

describe('drawSelectionPool', () => {
  it('draws poolSize ids uniformly from the eligible pool ids', () => {
    const candidateIds = new Set(['a', 'b', 'c', 'd', 'e']);
    const result = drawSelectionPool(candidateIds, {
      poolIds: new Set(['a', 'b', 'c', 'd', 'e']),
      poolSize: 2,
      seed: 1,
      excludeIds: new Set(),
    });
    expect(result.ids).toHaveLength(2);
    expect(result.ignoredCount).toBe(0);
    for (const id of result.ids) expect(candidateIds.has(id)).toBe(true);
  });

  it('excludes ids already drawn into the core sample', () => {
    const candidateIds = new Set(['a', 'b', 'c']);
    const result = drawSelectionPool(candidateIds, {
      poolIds: new Set(['a', 'b', 'c']),
      poolSize: 3,
      seed: 1,
      excludeIds: new Set(['a']),
    });
    expect(result.ids).not.toContain('a');
    expect(result.ids.sort()).toEqual(['b', 'c']);
  });

  it('reports pool ids absent from the candidate pool as ignored, without including them', () => {
    const candidateIds = new Set(['a', 'b']);
    const result = drawSelectionPool(candidateIds, {
      poolIds: new Set(['a', 'b', 'not-a-candidate']),
      poolSize: 5,
      seed: 1,
      excludeIds: new Set(),
    });
    expect(result.ignoredCount).toBe(1);
    expect(result.ids.sort()).toEqual(['a', 'b']);
  });

  it('is deterministic given the same seed', () => {
    const candidateIds = new Set(['a', 'b', 'c', 'd', 'e', 'f']);
    const opts = { poolIds: candidateIds, poolSize: 3, seed: 42, excludeIds: new Set<string>() };
    const first = drawSelectionPool(candidateIds, opts);
    const second = drawSelectionPool(candidateIds, opts);
    expect(first.ids).toEqual(second.ids);
  });
});

describe('buildGradingItems', () => {
  function makeGradingQuestion(overrides: Partial<GradingSourceQuestion> = {}): GradingSourceQuestion {
    return {
      id: 'q-1',
      question: 'q',
      correct_answer: 'a',
      type: 'fill-in-blank',
      difficulty: 'beginner',
      topic: 'Slang',
      unit_id: 'unit-1',
      writing_type: null,
      acceptable_variations: null,
      ...overrides,
    };
  }

  it('creates one item per label class per question, with an empty submitted_answer placeholder', () => {
    const items = buildGradingItems([makeGradingQuestion()], { perQuestion: GRADING_LABEL_CLASSES.length });
    expect(items).toHaveLength(GRADING_LABEL_CLASSES.length);
    for (const labelClass of GRADING_LABEL_CLASSES) {
      const item = items.find((i) => i.itemKey === `q-1:${labelClass}`);
      expect(item).toBeDefined();
      expect(item!.payload.submitted_answer).toBe('');
      expect(item!.payload.label_class).toBe(labelClass);
    }
  });

  it('sets seededClass to the same label class written into payload.label_class, on every item', () => {
    const items = buildGradingItems([makeGradingQuestion()], { perQuestion: GRADING_LABEL_CLASSES.length });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.seededClass).toBe(item.payload.label_class);
  });

  it('takes only the first perQuestion label classes when fewer are requested', () => {
    const items = buildGradingItems([makeGradingQuestion()], { perQuestion: 2 });
    expect(items.map((i) => i.payload.label_class)).toEqual([GRADING_LABEL_CLASSES[0], GRADING_LABEL_CLASSES[1]]);
  });

  it('produces item keys unique across multiple questions', () => {
    const items = buildGradingItems(
      [makeGradingQuestion({ id: 'a' }), makeGradingQuestion({ id: 'b' })],
      { perQuestion: GRADING_LABEL_CLASSES.length },
    );
    expect(new Set(items.map((i) => i.itemKey)).size).toBe(items.length);
  });
});

describe('buildMappingItems', () => {
  function makeUnit(overrides: Partial<MappingSourceUnit> = {}): MappingSourceUnit {
    return {
      id: 'unit-1',
      topics: [
        { name: 'Greetings', headings: ['Warm Up'] },
        { name: 'Practice', headings: [{ heading: 'Exercices', slide: 3 }] },
      ],
      ...overrides,
    };
  }

  it('creates one item per topic, keyed by topic name', () => {
    const result = buildMappingItems(makeUnit());
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.itemKey).sort()).toEqual(['Greetings', 'Practice']);
    expect(result.topicsWithNoHeadings).toEqual([]);
  });

  it('sets the payload to unit_id and topic only', () => {
    const result = buildMappingItems(makeUnit());
    const item = result.items.find((i) => i.itemKey === 'Greetings')!;
    expect(item.payload).toEqual({ unit_id: 'unit-1', topic: 'Greetings' });
  });

  it('sets reference from the topic\'s current headings, normalized to { heading, slide } form', () => {
    const result = buildMappingItems(makeUnit());
    const greetings = result.items.find((i) => i.itemKey === 'Greetings')!;
    const practice = result.items.find((i) => i.itemKey === 'Practice')!;
    expect(greetings.reference).toEqual({ headings: [{ heading: 'Warm Up', slide: null }] });
    expect(practice.reference).toEqual({ headings: [{ heading: 'Exercices', slide: 3 }] });
  });

  it('marks every item approved, reviewed by the corrected heading table, with a reviewedAt timestamp', () => {
    const result = buildMappingItems(makeUnit());
    for (const item of result.items) {
      expect(item.referenceStatus).toBe('approved');
      expect(item.reviewedBy).toBe('policy: corrected heading table');
      expect(item.reviewedAt).toBeTruthy();
      expect(new Date(item.reviewedAt!).toString()).not.toBe('Invalid Date');
    }
  });

  it('reports a topic with no headings without building a broken item for it', () => {
    const unit = makeUnit({
      topics: [
        { name: 'Greetings', headings: ['Warm Up'] },
        { name: 'Unmapped', headings: [] },
      ],
    });
    const result = buildMappingItems(unit);
    expect(result.topicsWithNoHeadings).toEqual(['Unmapped']);
    // The item still exists (the caller decides whether to refuse); its reference is just empty.
    const unmapped = result.items.find((i) => i.itemKey === 'Unmapped')!;
    expect(unmapped.reference).toEqual({ headings: [] });
  });
});

describe('hashPdfBytes', () => {
  it('is deterministic for the same bytes', () => {
    const bytes = Buffer.from('pdf-bytes');
    expect(hashPdfBytes(bytes)).toBe(hashPdfBytes(Buffer.from('pdf-bytes')));
  });

  it('differs when the bytes change', () => {
    expect(hashPdfBytes(Buffer.from('a'))).not.toBe(hashPdfBytes(Buffer.from('b')));
  });

  it('returns a 16-character hex string, the same convention as hashInputs', () => {
    expect(hashPdfBytes(Buffer.from('x'))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('categorizeTranscriptionSlides', () => {
  // Slides 1-3: image-dominated (per the report). Slide 4: skipped (no teaching content). Slides
  // 5-12: eligible for text/mixed, with text-layer lengths increasing with slide number.
  const report: TranscriptionConversionReport = {
    slideCount: 12,
    imageDominatedSlides: [1, 2, 3],
    skippedSlides: [{ slide: 4 }],
    flaggedSlides: [{ slide: 9, coverage: 0.5 }],
  };

  function makeSlides(): TranscriptionSlideInfo[] {
    const lengths: Record<number, number> = { 1: 5, 2: 5, 3: 5, 4: 5, 5: 10, 6: 20, 7: 30, 8: 40, 9: 200, 10: 300, 11: 400, 12: 500 };
    return Object.entries(lengths).map(([slide, length]) => ({ slide: Number(slide), textLayer: 'x'.repeat(length) }));
  }

  it('takes image-dominated slides straight from the report', () => {
    const result = categorizeTranscriptionSlides(makeSlides(), report);
    expect(result.imageDominated).toEqual([1, 2, 3]);
  });

  it('excludes skipped slides from both text and mixed', () => {
    const result = categorizeTranscriptionSlides(makeSlides(), report);
    expect(result.text).not.toContain(4);
    expect(result.mixed).not.toContain(4);
  });

  it('splits the remaining slides at the median by text-layer length: shorter half mixed, longer half text', () => {
    const result = categorizeTranscriptionSlides(makeSlides(), report);
    // Eligible slides (not image-dominated, not skipped): 5,6,7,8,9,10,11,12 — 8 slides, split 4/4.
    expect(result.mixed).toEqual([5, 6, 7, 8]);
    expect(result.text).toEqual([9, 10, 11, 12]);
  });

  it('is unaffected by flaggedSlides — flagging is a note carried at item-build time, not a category input', () => {
    const flaggedElsewhere: TranscriptionConversionReport = { ...report, flaggedSlides: [] };
    expect(categorizeTranscriptionSlides(makeSlides(), report)).toEqual(categorizeTranscriptionSlides(makeSlides(), flaggedElsewhere));
  });
});

describe('drawTranscriptionSample', () => {
  const categorized = {
    imageDominated: [1, 2, 3, 4, 5],
    text: [10, 11, 12, 13, 14],
    mixed: [20, 21, 22, 23, 24],
  };

  it('draws the same slides for the same seed (deterministic)', () => {
    const a = drawTranscriptionSample(categorized, { perCategory: 2, seed: 42 });
    const b = drawTranscriptionSample(categorized, { perCategory: 2, seed: 42 });
    expect(a.slides).toEqual(b.slides);
    expect(a.seed).toBe(42);
  });

  it('draws different slides for a different seed, in general', () => {
    const a = drawTranscriptionSample(categorized, { perCategory: 3, seed: 1 });
    const b = drawTranscriptionSample(categorized, { perCategory: 3, seed: 2 });
    expect(a.slides).not.toEqual(b.slides);
  });

  it('draws exactly perCategory slides from each category, all present in the source pool', () => {
    const result = drawTranscriptionSample(categorized, { perCategory: 2, seed: 7 });
    expect(result.slides['image-dominated']).toHaveLength(2);
    expect(result.slides.text).toHaveLength(2);
    expect(result.slides.mixed).toHaveLength(2);
    for (const slide of result.slides['image-dominated']) expect(categorized.imageDominated).toContain(slide);
    for (const slide of result.slides.text) expect(categorized.text).toContain(slide);
    for (const slide of result.slides.mixed) expect(categorized.mixed).toContain(slide);
  });

  it('refuses when a category has fewer slides than requested', () => {
    expect(() => drawTranscriptionSample(categorized, { perCategory: 6, seed: 1 })).toThrow(/image-dominated.*5.*6/);
  });

  it('generates and reports a fresh seed when none is given', () => {
    const result = drawTranscriptionSample(categorized, { perCategory: 1 });
    expect(typeof result.seed).toBe('number');
  });
});

describe('buildTranscriptionItems', () => {
  const slides: Record<'image-dominated' | 'text' | 'mixed', number[]> = { 'image-dominated': [1], text: [10], mixed: [20] };
  const textLayerBySlide = new Map([[1, 'img text'], [10, 'text slide'], [20, 'mixed slide']]);

  it('creates one item per drawn slide, keyed "<pdfName>:<slide>"', () => {
    const items = buildTranscriptionItems({ pdfName: 'Unit 1', slides, textLayerBySlide, flaggedSlides: new Set() });
    expect(items.map((i) => i.itemKey).sort()).toEqual(['Unit 1:1', 'Unit 1:10', 'Unit 1:20']);
  });

  it('sets the payload fields, reference left unset (pending)', () => {
    const items = buildTranscriptionItems({ pdfName: 'Unit 1', slides, textLayerBySlide, flaggedSlides: new Set() });
    const item = items.find((i) => i.itemKey === 'Unit 1:10')!;
    expect(item.payload).toEqual({
      pdf_name: 'Unit 1',
      slide: 10,
      category: 'text',
      text_layer: 'text slide',
      production_flagged: false,
    });
    expect(item.reference).toBeUndefined();
    expect(item.referenceStatus).toBeUndefined();
  });

  it('marks a slide the conversion report already flagged', () => {
    const items = buildTranscriptionItems({ pdfName: 'Unit 1', slides, textLayerBySlide, flaggedSlides: new Set([10]) });
    const item = items.find((i) => i.itemKey === 'Unit 1:10')!;
    expect(item.payload.production_flagged).toBe(true);
    const other = items.find((i) => i.itemKey === 'Unit 1:1')!;
    expect(other.payload.production_flagged).toBe(false);
  });

  it('defaults text_layer to empty string for a slide missing from the map', () => {
    const items = buildTranscriptionItems({ pdfName: 'Unit 1', slides, textLayerBySlide: new Map(), flaggedSlides: new Set() });
    expect(items.every((i) => i.payload.text_layer === '')).toBe(true);
  });
});
