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
 * A dry run must never call the model, but it must still show what a real run would generate:
 * the per-topic cap computed from content length (or the --count override that replaces it), and
 * a total that reflects those per-topic numbers rather than a single global count.
 */
const REAL_MARKDOWN = `## Heading A

${'Contenu de test. '.repeat(40)}
`;

const UNITS = [
  {
    id: 'unit-1',
    title: 'Unit 1',
    description: '',
    source_file_stem: null,
    topics: [{ name: 'Topic A', headings: ['Heading A'] }],
  },
];

describe('generateAllQuestions — dry-run cap display', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadUnitMaterialsMock.mockReturnValue(REAL_MARKDOWN);
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

  it('shows the computed per-topic cap and never calls the model', async () => {
    const expectedCap = computeQuestionCap(
      extractTopicContent(REAL_MARKDOWN, 'Topic A', UNITS).length,
    );

    const options = cli.parse(['--unit', 'unit-1', '--difficulty', 'advanced', '--dry-run']);
    await generateAllQuestions(options);

    expect(callLlmMock).not.toHaveBeenCalled();
    const logs = logText();
    expect(logs).toContain(`computed cap: ${expectedCap}`);
    expect(logs).toContain(`Would generate up to ${expectedCap} advanced questions for: Topic A`);
    expect(logs).toContain(`Estimated questions: ~${expectedCap}`);
  });

  it('--count overrides the computed cap for every topic in the run', async () => {
    const options = cli.parse(['--unit', 'unit-1', '--difficulty', 'advanced', '--dry-run', '--count', '3']);
    await generateAllQuestions(options);

    expect(callLlmMock).not.toHaveBeenCalled();
    const logs = logText();
    expect(logs).toContain('--count override: 3');
    expect(logs).toContain('Would generate up to 3 advanced questions for: Topic A');
    expect(logs).toContain('Estimated questions: ~3');
  });
});
