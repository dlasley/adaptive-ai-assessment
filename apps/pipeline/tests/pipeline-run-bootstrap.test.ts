import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createScriptSupabaseMock, fetchUnitsFromDbMock, stepConvertPdfMock } = vi.hoisted(() => ({
  createScriptSupabaseMock: vi.fn(() => ({})),
  fetchUnitsFromDbMock: vi.fn(),
  stepConvertPdfMock: vi.fn(),
}));

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

/**
 * `main()` previously parsed argv twice: once via its own `parseArgs()`, once again inside
 * `bootstrapCommand()`. A deprecated-alias warning is emitted from inside `cli.parse()`, so it's
 * a direct observable of that double-parse — it printed twice, and a second Supabase client was
 * created alongside it.
 */
describe('pipeline-run main() — single-parse bootstrap', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchUnitsFromDbMock.mockResolvedValue(UNITS);
    stepConvertPdfMock.mockResolvedValue({ success: true, markdownPath: 'fake.md' });
    process.argv = ['node', 'pipeline-run.ts', 'unit-1', '--sync-db', '--convert-only'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createScriptSupabaseMock.mockClear();
    fetchUnitsFromDbMock.mockReset();
    stepConvertPdfMock.mockReset();
    process.argv = originalArgv;
  });

  it('warns about a deprecated alias exactly once', async () => {
    await main();

    const warnCalls = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((args) => String(args[0]).includes('--sync-db is deprecated'));
    expect(warnCalls).toHaveLength(1);
  });

  it('creates exactly one Supabase client per run', async () => {
    await main();

    expect(createScriptSupabaseMock).toHaveBeenCalledTimes(1);
    expect(fetchUnitsFromDbMock).toHaveBeenCalledTimes(1);
  });
});
