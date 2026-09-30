import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { callLlmMock, fetchUnitsFromDbMock, loadUnitMaterialsMock, createScriptSupabaseMock } = vi.hoisted(() => ({
  callLlmMock: vi.fn(),
  fetchUnitsFromDbMock: vi.fn(),
  loadUnitMaterialsMock: vi.fn(),
  createScriptSupabaseMock: vi.fn(() => ({})),
}));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

vi.mock('../src/lib/units-db', () => ({
  fetchUnitsFromDb: fetchUnitsFromDbMock,
}));

vi.mock('../src/lib/db-queries', () => ({
  createScriptSupabase: createScriptSupabaseMock,
}));

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: loadUnitMaterialsMock,
}));

import { generateAllQuestions, cli } from '../src/commands/questions-generate';
import { extractTopicContent } from '../src/lib/learning-materials';
import { computeQuestionCap } from '../src/lib/pipeline-config';

/**
 * Hybrid mode (any non-advanced difficulty, no --model/--type) splits the effective count across a
 * structured pass and a typed pass. The two passes must always sum to exactly the effective count —
 * splitting with ceil on both sides silently requests one extra question whenever that count is odd.
 */
const UNITS = [
  {
    id: 'unit-1',
    title: 'Unit 1',
    description: '',
    source_file_stem: null,
    topics: [{ name: 'Topic A', headings: ['Heading A'] }],
  },
];

describe('generateAllQuestions — hybrid-mode pass split', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchUnitsFromDbMock.mockResolvedValue(UNITS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchUnitsFromDbMock.mockReset();
    loadUnitMaterialsMock.mockReset();
    callLlmMock.mockReset();
  });

  function logText(): string {
    return (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((args) => args.join(' '))
      .join('\n');
  }

  it('splits an odd computed cap into ceil + floor, summing to exactly the cap', async () => {
    const markdown = `## Heading A\n\n${'Contenu de test. '.repeat(24)}\n`;
    loadUnitMaterialsMock.mockReturnValue(markdown);
    const cap = computeQuestionCap(extractTopicContent(markdown, 'Topic A', UNITS).length);
    expect(cap % 2).toBe(1); // this fixture is chosen to land on an odd cap

    const options = cli.parse(['--unit', 'unit-1', '--difficulty', 'beginner', '--dry-run']);
    await generateAllQuestions(options);

    const logs = logText();
    expect(logs).toContain(`Would generate up to ${Math.ceil(cap / 2)} beginner [multiple-choice/true-false] questions for: Topic A`);
    expect(logs).toContain(`Would generate up to ${Math.floor(cap / 2)} beginner [fill-in-blank/writing] questions for: Topic A`);
    expect(logs).toContain(`Estimated questions: ~${cap}`);
  });

  it('splits an even computed cap evenly', async () => {
    const markdown = `## Heading A\n\n${'Contenu de test. '.repeat(30)}\n`;
    loadUnitMaterialsMock.mockReturnValue(markdown);
    const cap = computeQuestionCap(extractTopicContent(markdown, 'Topic A', UNITS).length);
    expect(cap % 2).toBe(0); // this fixture is chosen to land on an even cap

    const options = cli.parse(['--unit', 'unit-1', '--difficulty', 'beginner', '--dry-run']);
    await generateAllQuestions(options);

    const logs = logText();
    expect(logs).toContain(`Would generate up to ${cap / 2} beginner [multiple-choice/true-false] questions for: Topic A`);
    expect(logs).toContain(`Would generate up to ${cap / 2} beginner [fill-in-blank/writing] questions for: Topic A`);
    expect(logs).toContain(`Estimated questions: ~${cap}`);
  });

  it('--count 1 drops the zero-count typed pass instead of requesting 0 questions', async () => {
    loadUnitMaterialsMock.mockReturnValue('## Heading A\n\nAnything.\n');

    const options = cli.parse(['--unit', 'unit-1', '--difficulty', 'beginner', '--dry-run', '--count', '1']);
    await generateAllQuestions(options);

    const logs = logText();
    expect(logs).toContain('Would generate up to 1 beginner [multiple-choice/true-false] questions for: Topic A');
    expect(logs).not.toContain('fill-in-blank/writing');
    expect(logs).toContain('Estimated questions: ~1');
    expect(callLlmMock).not.toHaveBeenCalled();
  });
});
