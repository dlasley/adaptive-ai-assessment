/**
 * `eval-review-export`'s `--all-classes` (grading) and `--from-run` (transcription) flags, driven
 * through `main()` against an injected in-memory `EvalStore`, the same style as
 * `eval-review-export-write-guard.test.ts` exercises the write guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { main } from '../src/commands/eval-review-export';
import type { EvalStore, EvalResultRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow, makeEvalResultRow } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('eval-review-export --all-classes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-review-export-all-classes-'));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeGradingStore(): EvalStore {
    const set = makeEvalSetRow({ task: 'grading' });
    const items = [
      makeEvalItemRow({
        id: 'item-correct', item_key: 'item-correct', set_id: set.id,
        payload: { question_id: 'q-1', type: 'fill-in-blank', question: 'Q1', correct_answer: 'a', submitted_answer: 'a', label_class: 'correct' },
      }),
      makeEvalItemRow({
        id: 'item-typo', item_key: 'item-typo', set_id: set.id,
        payload: { question_id: 'q-2', type: 'fill-in-blank', question: 'Q2', correct_answer: 'b', submitted_answer: 'b', label_class: 'typo' },
      }),
    ];
    return {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === set.id ? set : null; },
      async listItems(setId) { return setId === set.id ? items : []; },
    };
  }

  function readWrittenCsv(outPath: string): string[] {
    return readFileSync(outPath, 'utf-8').trim().split('\n');
  }

  it('excludes typo/missing_accent items by default', async () => {
    const store = makeGradingStore();
    const outPath = join(dir, 'grading-reference.csv');

    await main({ argv: ['--set', 'set-1', '--out', outPath, '--format', 'csv', '--seed', '1'], store });

    // header + description row + exactly one data row (the policy-labelled item is excluded).
    expect(readWrittenCsv(outPath)).toHaveLength(3);
  });

  it('includes typo/missing_accent items with --all-classes', async () => {
    const store = makeGradingStore();
    const outPath = join(dir, 'grading-reference-all.csv');

    await main({ argv: ['--set', 'set-1', '--out', outPath, '--format', 'csv', '--seed', '1', '--all-classes'], store });

    expect(readWrittenCsv(outPath)).toHaveLength(4);
  });

  it('refuses --all-classes on a non-grading set', async () => {
    const auditSet = makeEvalSetRow({ task: 'audit' });
    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === auditSet.id ? auditSet : null; },
    };

    await expect(
      main({ argv: ['--set', 'set-1', '--out', join(dir, 'audit.csv'), '--all-classes'], store }),
    ).rejects.toThrow(ProcessExitError);
  });
});

describe('eval-review-export --from-run', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-review-export-from-run-'));
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeTranscriptionStore(results: EvalResultRow[]): EvalStore {
    const set = makeEvalSetRow({ task: 'transcription', selection: { pdfPath: 'unit-1.pdf' } });
    const item = makeEvalItemRow({ id: 'item-1', item_key: 'slide-1', set_id: set.id, payload: { slide: 1, category: 'text' } });
    return {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === set.id ? set : null; },
      async listItems(setId) { return setId === set.id ? [item] : []; },
      async listResults(runId) { return runId === 'run-1' ? results : []; },
    };
  }

  it('leaves slide files empty without --from-run', async () => {
    const store = makeTranscriptionStore([]);
    const outDir = join(dir, 'export-empty');

    await main({ argv: ['--set', 'set-1', '--out', outDir], store });

    expect(readFileSync(join(outDir, '1.md'), 'utf-8')).toBe('');
  });

  it('prefills slide files from --from-run\'s output', async () => {
    const results = [makeEvalResultRow({ id: 'result-1', run_id: 'run-1', item_id: 'item-1', output: { markdown: 'Transcribed vocabulary.' } })];
    const store = makeTranscriptionStore(results);
    const outDir = join(dir, 'export-prefilled');

    await main({ argv: ['--set', 'set-1', '--out', outDir, '--from-run', 'run-1'], store });

    expect(readFileSync(join(outDir, '1.md'), 'utf-8')).toBe('Transcribed vocabulary.');
    expect(readdirSync(outDir)).toContain('README.md');
  });

  it('refuses --from-run on a non-transcription set', async () => {
    const auditSet = makeEvalSetRow({ task: 'audit' });
    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === auditSet.id ? auditSet : null; },
    };

    await expect(
      main({ argv: ['--set', 'set-1', '--out', join(dir, 'audit.csv'), '--from-run', 'run-1'], store }),
    ).rejects.toThrow(ProcessExitError);
  });
});
