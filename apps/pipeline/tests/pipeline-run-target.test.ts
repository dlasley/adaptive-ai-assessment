import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { assertSupabaseTargetMock, createScriptSupabaseMock, fetchUnitsFromDbMock, stepConvertPdfMock } = vi.hoisted(() => ({
  assertSupabaseTargetMock: vi.fn(),
  createScriptSupabaseMock: vi.fn(() => ({})),
  fetchUnitsFromDbMock: vi.fn(),
  stepConvertPdfMock: vi.fn(),
}));

vi.mock('../src/lib/supabase-target', () => ({ assertSupabaseTarget: assertSupabaseTargetMock }));
vi.mock('../src/lib/db-queries', () => ({ createScriptSupabase: createScriptSupabaseMock }));
vi.mock('../src/lib/units-db', () => ({ fetchUnitsFromDb: fetchUnitsFromDbMock }));
vi.mock('../src/lib/pipeline-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pipeline-steps')>()),
  stepConvertPdf: stepConvertPdfMock,
}));

import { main } from '../src/commands/pipeline-run';

const UNITS = [{ id: 'unit-1', title: 'Unit 1', description: '', source_file_stem: null, topics: [] }];

describe('pipeline-run checks the write target before any paid step', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchUnitsFromDbMock.mockResolvedValue(UNITS);
    stepConvertPdfMock.mockResolvedValue({ success: true, markdownPath: 'fake.md' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    assertSupabaseTargetMock.mockReset();
    stepConvertPdfMock.mockReset();
    process.argv = originalArgv;
  });

  it('confirms the target for --write-db before PDF conversion starts', async () => {
    process.argv = ['node', 'pipeline-run.ts', 'unit-1', '--write-db', '--convert-only'];

    await main();

    expect(assertSupabaseTargetMock).toHaveBeenCalledWith({ write: true });
    expect(assertSupabaseTargetMock.mock.invocationCallOrder[0]).toBeLessThan(
      stepConvertPdfMock.mock.invocationCallOrder[0],
    );
  });

  it('does not check a write target without --write-db', async () => {
    process.argv = ['node', 'pipeline-run.ts', 'unit-1', '--convert-only'];

    await main();

    expect(assertSupabaseTargetMock).not.toHaveBeenCalled();
  });

  it('does not check a write target on a dry run', async () => {
    process.argv = ['node', 'pipeline-run.ts', 'unit-1', '--write-db', '--dry-run', '--convert-only'];

    await main();

    expect(assertSupabaseTargetMock).not.toHaveBeenCalled();
  });
});
