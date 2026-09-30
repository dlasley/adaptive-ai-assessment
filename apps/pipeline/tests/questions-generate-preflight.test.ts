import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

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

/**
 * `generateAllQuestions` validates every topic's stored headings against the unit's current
 * markdown before generating anything. A unit whose headings are legacy word-token lists (the
 * shape stored before exact-heading matching) never resolves under exact matching, so this
 * preflight must stop the run — not let it fall through to a per-topic warning and zero
 * questions written.
 */
const REAL_MARKDOWN = `## Révision: Present Tense of Regular Verbs

Content about regular verb conjugation.
`;

describe('generateAllQuestions — heading preflight', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadUnitMaterialsMock.mockReturnValue(REAL_MARKDOWN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fetchUnitsFromDbMock.mockReset();
    loadUnitMaterialsMock.mockReset();
    callLlmMock.mockReset();
  });

  it('exits non-zero naming the unit and mismatched heading, and never calls the model, for legacy word-token headings', async () => {
    fetchUnitsFromDbMock.mockResolvedValue([
      {
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [
          {
            name: 'Verb Conjugation',
            // Legacy shape: lowercased, split-on-whitespace word tokens — never a real heading
            // under exact matching.
            headings: ['révision:', 'present', 'tense', 'regular', 'verbs'],
          },
        ],
      },
    ]);

    const options = cli.parse(['--unit', 'unit-1']);

    await expect(generateAllQuestions(options)).rejects.toThrow(ProcessExitError);

    expect(callLlmMock).not.toHaveBeenCalled();

    const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const errorText = errorCalls.map(args => args.join(' ')).join('\n');
    expect(errorText).toContain('unit-1');
    expect(errorText).toContain('révision:');
    expect(errorText).toContain('--map-existing');
  });

  it('does not exit and proceeds toward generation when headings validate', async () => {
    fetchUnitsFromDbMock.mockResolvedValue([
      {
        id: 'unit-1',
        title: 'Unit 1',
        description: '',
        source_file_stem: null,
        topics: [
          { name: 'Verb Conjugation', headings: ['Révision: Present Tense of Regular Verbs'] },
        ],
      },
    ]);
    callLlmMock.mockResolvedValue({ text: JSON.stringify({ questions: [] }) });

    const options = cli.parse(['--unit', 'unit-1', '--dry-run']);

    // --dry-run short-circuits before any generation call, but must get past the preflight
    // first — a thrown ProcessExitError here would mean the preflight wrongly rejected valid
    // headings.
    await expect(generateAllQuestions(options)).resolves.toBeUndefined();
  });
});
