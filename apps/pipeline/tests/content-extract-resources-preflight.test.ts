import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const { loadUnitMaterialsMock } = vi.hoisted(() => ({ loadUnitMaterialsMock: vi.fn() }));

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: loadUnitMaterialsMock,
}));

import { preflightHeadings } from '../src/commands/content-extract-resources';

const REAL_MARKDOWN = `## Révision: Present Tense of Regular Verbs

Content about regular verb conjugation.
`;

/**
 * `preflightHeadings` is the same validation `questions-generate.ts` runs before generating,
 * applied to the units content-extract-resources.ts is about to scan. Legacy word-token
 * headings (the shape stored before exact-heading matching) never resolve here either.
 */
describe('preflightHeadings', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadUnitMaterialsMock.mockReturnValue(REAL_MARKDOWN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    loadUnitMaterialsMock.mockReset();
  });

  it('exits non-zero naming the unit and mismatched heading for legacy word-token headings', () => {
    const unit = {
      id: 'unit-1',
      title: 'Unit 1',
      description: '',
      source_file_stem: null,
      topics: [
        { name: 'Verb Conjugation', headings: ['révision:', 'present', 'tense', 'regular', 'verbs'] },
      ],
    } as never;

    expect(() => preflightHeadings([unit], [unit])).toThrow(ProcessExitError);

    const errorCalls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const errorText = errorCalls.map(args => args.join(' ')).join('\n');
    expect(errorText).toContain('unit-1');
    expect(errorText).toContain('révision:');
    expect(errorText).toContain('--map-existing');
  });

  it('does not exit when headings validate', () => {
    const unit = {
      id: 'unit-1',
      title: 'Unit 1',
      description: '',
      source_file_stem: null,
      topics: [
        { name: 'Verb Conjugation', headings: ['Révision: Present Tense of Regular Verbs'] },
      ],
    } as never;

    expect(() => preflightHeadings([unit], [unit])).not.toThrow();
  });

  it('skips a unit whose markdown file cannot be loaded, rather than failing the preflight', () => {
    loadUnitMaterialsMock.mockImplementation(() => {
      throw new Error('No markdown file found for unit: unit-missing');
    });
    const unit = {
      id: 'unit-missing',
      title: 'Missing Unit',
      description: '',
      source_file_stem: null,
      topics: [{ name: 'Some Topic', headings: ['some', 'legacy', 'tokens'] }],
    } as never;

    expect(() => preflightHeadings([unit], [unit])).not.toThrow();
  });
});
