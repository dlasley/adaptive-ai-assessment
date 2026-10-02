import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runScriptMock, runScriptAsyncMock } = vi.hoisted(() => ({
  runScriptMock: vi.fn(),
  runScriptAsyncMock: vi.fn(),
}));

vi.mock('../src/lib/script-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/script-runner')>()),
  runScript: runScriptMock,
  runScriptAsync: runScriptAsyncMock,
}));

import { stepAuditQuestions, stepExtractResources, stepGenerateQuestions, type StepOptions } from '../src/lib/pipeline-steps';

/**
 * A child command re-reads its own argv to decide whether the write target is confirmed, so the
 * orchestrator has to pass `--yes-production` down to every child that writes.
 */
const WRITING: StepOptions = { dryRun: false, writeDb: true, auditor: 'mistral', yesProduction: true };
const NOT_CONFIRMED: StepOptions = { ...WRITING, yesProduction: false };

describe('pipeline steps forward the production confirmation to writing children', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    runScriptMock.mockReturnValue({ success: true });
    runScriptAsyncMock.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    runScriptMock.mockReset();
    runScriptAsyncMock.mockReset();
  });

  it('question generation', async () => {
    await stepGenerateQuestions('unit-1', [], WRITING, []);
    expect(runScriptAsyncMock.mock.calls[0][1]).toContain('--yes-production');

    runScriptAsyncMock.mockClear();
    await stepGenerateQuestions('unit-1', [], NOT_CONFIRMED, []);
    expect(runScriptAsyncMock.mock.calls[0][1]).not.toContain('--yes-production');
  });

  it('audit', async () => {
    await stepAuditQuestions('unit-1', WRITING);
    expect(runScriptAsyncMock.mock.calls[0][1]).toContain('--yes-production');

    runScriptAsyncMock.mockClear();
    await stepAuditQuestions('unit-1', NOT_CONFIRMED);
    expect(runScriptAsyncMock.mock.calls[0][1]).not.toContain('--yes-production');
  });

  it('resource extraction', async () => {
    await stepExtractResources('unit-1', WRITING);
    expect(runScriptMock.mock.calls[0][1]).toContain('--yes-production');

    runScriptMock.mockClear();
    await stepExtractResources('unit-1', NOT_CONFIRMED);
    expect(runScriptMock.mock.calls[0][1]).not.toContain('--yes-production');
  });
});
