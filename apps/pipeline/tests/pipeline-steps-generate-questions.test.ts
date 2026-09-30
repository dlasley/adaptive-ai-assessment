import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadUnitMaterialsMock, runScriptAsyncMock } = vi.hoisted(() => ({
  loadUnitMaterialsMock: vi.fn(),
  runScriptAsyncMock: vi.fn(),
}));

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: loadUnitMaterialsMock,
}));

vi.mock('../src/lib/script-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/script-runner')>()),
  runScriptAsync: runScriptAsyncMock,
}));

import { stepGenerateQuestions, StepOptions } from '../src/lib/pipeline-steps';
import { extractTopicContent } from '../src/lib/learning-materials';
import { computeQuestionCap } from '../src/lib/pipeline-config';
import { DIFFICULTIES } from '@adaptive/shared/enums';
import type { Unit } from '@adaptive/shared/types';

/**
 * `stepGenerateQuestions`'s dry-run branch estimates question count with `computeQuestionCap`, the
 * same content-sized default `questions-generate.ts` itself uses. This checks the step's estimate
 * against that same computation, not a hand-derived number, so the two can't silently drift apart.
 */
const UNITS: Unit[] = [
  {
    id: 'unit-1',
    title: 'Unit 1',
    description: '',
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

const BASE_OPTIONS: StepOptions = {
  dryRun: true,
  writeDb: false,
  auditor: 'mistral',
};

describe('stepGenerateQuestions — dry-run estimate', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    loadUnitMaterialsMock.mockReturnValue(MARKDOWN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadUnitMaterialsMock.mockReset();
    runScriptAsyncMock.mockReset();
  });

  it('estimates from each topic\'s computed cap, not a flat per-topic count', async () => {
    const topics = ['Topic A', 'Topic B'];
    const expected = topics.reduce(
      (sum, topic) => sum + computeQuestionCap(extractTopicContent(MARKDOWN, topic, UNITS).length) * DIFFICULTIES.length,
      0,
    );
    // Topic A (real content) and Topic B (a couple of words) must land on different caps, or this
    // test would pass even with the old flat-10 formula.
    expect(expected).not.toBe(topics.length * 3 * 10);

    const result = await stepGenerateQuestions('unit-1', topics, BASE_OPTIONS, UNITS);

    expect(result).toEqual({ success: true, count: expected });
    expect(runScriptAsyncMock).not.toHaveBeenCalled();
  });
});
