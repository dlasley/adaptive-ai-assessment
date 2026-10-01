import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { extractSlideTextMock } = vi.hoisted(() => ({
  extractSlideTextMock: vi.fn(() => 'some slide text'),
}));

// Shells out to the pdftotext binary against a real PDF; the transcription --write-db test below
// supplies a placeholder file for hashing only, so the text layer itself is stubbed.
vi.mock('../src/lib/pdf-conversion', () => ({
  extractSlideText: extractSlideTextMock,
}));

import { cli, main } from '../src/commands/eval-set-create';
import type { EvalStore, NewEvalSetRow, NewEvalItemRow } from '../src/lib/eval/db';
import { baseFakeEvalStore } from './helpers/eval-store';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function expectExit(fn: () => void, code: number) {
  try {
    fn();
    throw new Error('expected process.exit to be called');
  } catch (err) {
    expect(err).toBeInstanceOf(ProcessExitError);
    expect((err as ProcessExitError).code).toBe(code);
  }
}

/**
 * `--unit` moved from a mapping-only requirement to a requirement for every task (eval-set-create
 * always writes eval_sets.unit_id now) — these exercise `cli.parse`'s `validate` callback directly,
 * without a live Supabase connection or an injected store.
 */
describe('eval-set-create cli: --unit required for every task', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses --task audit with no --unit, naming --unit rather than the audit-specific --size check', () => {
    expectExit(() => cli.parse(['--task', 'audit', '--size', '10', '--label', 'l']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--unit is required'));
  });

  it('refuses --task grading with no --unit', () => {
    expectExit(() => cli.parse(['--task', 'grading', '--label', 'l']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--unit is required'));
  });

  it('refuses --task mapping with no --unit even when --markdown is given', () => {
    expectExit(() => cli.parse(['--task', 'mapping', '--markdown', 'Unit 1.md', '--label', 'l']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--unit is required'));
  });

  it('refuses --task transcription with no --unit even when --pdf/--report/--per-category are given', () => {
    expectExit(
      () => cli.parse([
        '--task', 'transcription',
        '--pdf', 'Unit 1.pdf',
        '--report', 'Unit 1.conversion-report.json',
        '--per-category', '10',
        '--label', 'l',
      ]),
      1,
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--unit is required'));
  });

  it('accepts --task audit once --unit is given, alongside --size', () => {
    const options = cli.parse(['--task', 'audit', '--unit', 'unit-1', '--size', '10', '--label', 'l']);
    expect(options.unit).toBe('unit-1');
  });

  it('accepts --task grading once --unit is given', () => {
    const options = cli.parse(['--task', 'grading', '--unit', 'unit-1', '--label', 'l']);
    expect(options.unit).toBe('unit-1');
  });

  it('accepts --task mapping once --unit is given, alongside --markdown', () => {
    const options = cli.parse(['--task', 'mapping', '--unit', 'unit-1', '--markdown', 'Unit 1.md', '--label', 'l']);
    expect(options.unit).toBe('unit-1');
  });

  it('accepts --task transcription once --unit is given, alongside --pdf/--report/--per-category', () => {
    const options = cli.parse([
      '--task', 'transcription',
      '--unit', 'unit-1',
      '--pdf', 'Unit 1.pdf',
      '--report', 'Unit 1.conversion-report.json',
      '--per-category', '10',
      '--label', 'l',
    ]);
    expect(options.unit).toBe('unit-1');
  });

  it('still refuses --task mapping missing --markdown even when --unit is present (the mapping-specific check still runs)', () => {
    expectExit(() => cli.parse(['--task', 'mapping', '--unit', 'unit-1', '--label', 'l']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--markdown is required'));
  });
});

/**
 * The five audit-sampling flags (`--include-ids`, `--exclude-topics`, `--balance-status`,
 * `--pool-ids`, `--pool-size`) all drive `runAuditSetCreate`, which (like the rest of the audit
 * task) opens a real Supabase client for its `questions` read even when a store is injected; see
 * `main()`'s own doc comment above `--task transcription`'s describe block below. These are
 * CLI-parsing-level tests only; the sampling logic itself (`drawSelectionPool`, `excludeTopics`) is
 * covered in `eval-set-builder.test.ts`.
 */
describe('eval-set-create cli: audit sampling flags', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = ['--task', 'audit', '--unit', 'unit-1', '--size', '10', '--label', 'l'];

  it('parses --include-ids as the given path', () => {
    expect(cli.parse([...base, '--include-ids', 'ids.txt']).includeIds).toBe('ids.txt');
  });

  it('parses --exclude-topics as the given path', () => {
    expect(cli.parse([...base, '--exclude-topics', 'topics.txt']).excludeTopics).toBe('topics.txt');
  });

  it('defaults --balance-status to false and parses the flag as true', () => {
    expect(cli.parse(base).balanceStatus).toBe(false);
    expect(cli.parse([...base, '--balance-status']).balanceStatus).toBe(true);
  });

  it('parses --pool-ids and --pool-size together', () => {
    const options = cli.parse([...base, '--pool-ids', 'pool.txt', '--pool-size', '5']);
    expect(options.poolIds).toBe('pool.txt');
    expect(options.poolSize).toBe(5);
  });

  it('refuses --pool-size without --pool-ids', () => {
    expectExit(() => cli.parse([...base, '--pool-size', '5']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--pool-ids and --pool-size must be given together'));
  });

  it('refuses --pool-ids without --pool-size', () => {
    expectExit(() => cli.parse([...base, '--pool-ids', 'pool.txt']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--pool-ids and --pool-size must be given together'));
  });
});

/**
 * `--task transcription` is the one task whose --write-db path needs no live Supabase read beyond
 * the eval store itself (audit/grading/mapping all read `questions`/`units` through a real client
 * even when a store is injected — see `main()`'s own doc comment) — so it's the task this suite can
 * drive end to end against a fake `EvalStore`, with `extractSlideText` stubbed above to avoid
 * shelling out to `pdftotext`.
 */
describe('eval-set-create main() --task transcription --write-db', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-set-create-transcription-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('samples one slide per category and writes eval_sets/eval_items through the injected store', async () => {
    const pdfPath = join(dir, 'Unit 1.pdf');
    const reportPath = join(dir, 'Unit 1.conversion-report.json');
    writeFileSync(pdfPath, 'not a real pdf, only its bytes are hashed');
    writeFileSync(reportPath, JSON.stringify({
      slideCount: 3,
      imageDominatedSlides: [1],
      skippedSlides: [],
      flaggedSlides: [],
    }));

    const insertSetCalls: NewEvalSetRow[] = [];
    const insertItemsCalls: NewEvalItemRow[][] = [];
    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async insertSet(row) {
        insertSetCalls.push(row);
        return { id: 'set-1', unit_id: null, selection: {}, inputs_hash: null, label: null, created_at: '', updated_at: '', item_count: 0, ...row };
      },
      async insertItems(rows) {
        insertItemsCalls.push(rows);
        return rows.map((r, i) => ({ id: `item-${i + 1}`, seeded_class: null, reference: null, reference_status: 'pending', reviewed_by: null, reviewed_at: null, notes: null, created_at: '', updated_at: '', ...r }));
      },
    };

    await main({
      argv: [
        '--task', 'transcription',
        '--unit', 'unit-1',
        '--pdf', pdfPath,
        '--report', reportPath,
        '--per-category', '1',
        '--label', 'test transcription set',
        '--write-db',
      ],
      store,
    });

    expect(extractSlideTextMock).toHaveBeenCalled();
    expect(insertSetCalls).toHaveLength(1);
    expect(insertSetCalls[0].task).toBe('transcription');
    expect(insertSetCalls[0].item_count).toBe(3);
    expect(insertItemsCalls).toHaveLength(1);
    expect(insertItemsCalls[0]).toHaveLength(3);
  });
});
