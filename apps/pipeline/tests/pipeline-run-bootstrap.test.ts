import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createScriptSupabaseMock, fetchUnitsFromDbMock, stepConvertPdfMock } = vi.hoisted(() => ({
  createScriptSupabaseMock: vi.fn(() => ({})),
  fetchUnitsFromDbMock: vi.fn(),
  stepConvertPdfMock: vi.fn(),
}));

vi.mock('../src/lib/supabase-target', () => ({ assertSupabaseTarget: vi.fn() }));

vi.mock('../src/lib/db-queries', () => ({
  createScriptSupabase: createScriptSupabaseMock,
}));

vi.mock('../src/lib/units-db', () => ({
  fetchUnitsFromDb: fetchUnitsFromDbMock,
}));

vi.mock('../src/lib/pipeline-steps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pipeline-steps')>()),
  stepConvertPdf: stepConvertPdfMock,
}));

import { main } from '../src/commands/pipeline-run';

const UNITS = [
  {
    id: 'unit-1',
    title: 'Unit 1',
    description: '',
    source_file_stem: null,
    topics: [],
  },
];

/** `main()` parses argv once; a second parse would create a second Supabase client. */
describe('pipeline-run main() — single-parse bootstrap', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchUnitsFromDbMock.mockResolvedValue(UNITS);
    stepConvertPdfMock.mockResolvedValue({ success: true, markdownPath: 'fake.md' });
    process.argv = ['node', 'pipeline-run.ts', 'unit-1', '--write-db', '--convert-only'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createScriptSupabaseMock.mockClear();
    fetchUnitsFromDbMock.mockReset();
    stepConvertPdfMock.mockReset();
    process.argv = originalArgv;
  });

  it('creates exactly one Supabase client per run', async () => {
    await main();

    expect(createScriptSupabaseMock).toHaveBeenCalledTimes(1);
    expect(fetchUnitsFromDbMock).toHaveBeenCalledTimes(1);
  });
});
