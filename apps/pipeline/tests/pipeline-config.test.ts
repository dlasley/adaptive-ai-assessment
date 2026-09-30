import { describe, expect, it, vi } from 'vitest';

const { loadUnitMaterialsMock } = vi.hoisted(() => ({ loadUnitMaterialsMock: vi.fn() }));

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: loadUnitMaterialsMock,
}));

import {
  computeQuestionCap,
  computeTopicQuestionCap,
  estimateUnitQuestionCount,
  CHARS_PER_QUESTION_CAP,
  MIN_QUESTIONS_PER_TOPIC_DIFFICULTY,
  MAX_QUESTIONS_PER_TOPIC_DIFFICULTY,
} from '../src/lib/pipeline-config';
import { DIFFICULTIES } from '@adaptive/shared/enums';

describe('computeQuestionCap', () => {
  it('floors at MIN_QUESTIONS_PER_TOPIC_DIFFICULTY for very little content', () => {
    expect(computeQuestionCap(0)).toBe(MIN_QUESTIONS_PER_TOPIC_DIFFICULTY);
    expect(computeQuestionCap(50)).toBe(MIN_QUESTIONS_PER_TOPIC_DIFFICULTY);
  });

  it('ceilings at MAX_QUESTIONS_PER_TOPIC_DIFFICULTY for a lot of content', () => {
    expect(computeQuestionCap(5014)).toBe(MAX_QUESTIONS_PER_TOPIC_DIFFICULTY);
    expect(computeQuestionCap(100_000)).toBe(MAX_QUESTIONS_PER_TOPIC_DIFFICULTY);
  });

  it('scales roughly one question per CHARS_PER_QUESTION_CAP characters between the bounds', () => {
    expect(computeQuestionCap(CHARS_PER_QUESTION_CAP * 5)).toBe(5);
    expect(computeQuestionCap(CHARS_PER_QUESTION_CAP * 7)).toBe(7);
  });

  it('rounds to the nearest question rather than always flooring or ceiling', () => {
    // 620 / 150 = 4.13 -> rounds down to 4
    expect(computeQuestionCap(620)).toBe(4);
    // 680 / 150 = 4.53 -> rounds up to 5
    expect(computeQuestionCap(680)).toBe(5);
  });
});

describe('computeTopicQuestionCap / estimateUnitQuestionCount', () => {
  const UNITS = [
    {
      id: 'unit-1',
      source_file_stem: null,
      topics: [
        { name: 'Topic A', headings: ['Heading A'] },
        { name: 'Topic B', headings: ['Heading B'] },
      ],
    },
  ];

  const MARKDOWN = `## Heading A

${'Contenu de test. '.repeat(24)}

## Heading B

Short.
`;

  it('resolves a single topic\'s cap from its own extracted content', () => {
    loadUnitMaterialsMock.mockReturnValue(MARKDOWN);

    const capA = computeTopicQuestionCap('unit-1', 'Topic A', UNITS);
    const capB = computeTopicQuestionCap('unit-1', 'Topic B', UNITS);

    // Topic A has real content, Topic B has almost none — they must not collapse to the same cap,
    // or this wouldn't be testing per-topic resolution at all.
    expect(capA).toBeGreaterThan(capB);
    expect(capB).toBe(MIN_QUESTIONS_PER_TOPIC_DIFFICULTY);
  });

  it('sums each topic\'s cap once per difficulty', () => {
    loadUnitMaterialsMock.mockReturnValue(MARKDOWN);

    const topics = ['Topic A', 'Topic B'];
    const expected = topics
      .map((topic) => computeTopicQuestionCap('unit-1', topic, UNITS))
      .reduce((sum, cap) => sum + cap * DIFFICULTIES.length, 0);

    expect(estimateUnitQuestionCount('unit-1', topics, UNITS)).toBe(expected);
  });
});
