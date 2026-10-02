import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cli, pruneStudyCodes } from '../src/commands/db-prune-study-codes';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const NOW = new Date('2026-10-01T00:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

interface FakeData {
  study_codes: { id: string; last_active_at: string; is_superuser?: boolean }[];
  quiz_history: { id: string; study_code_id: string }[];
}

/** Just enough of the query builder for fetchAllPages and the prune command's filters and delete. */
function fakeSupabase(data: FakeData) {
  const deletedIds: string[] = [];
  const client = {
    from(table: keyof FakeData) {
      let rows: Record<string, string | boolean | undefined>[] = data[table];
      const builder: Record<string, unknown> = {
        select: () => builder,
        lt: (column: string, value: string) => {
          rows = rows.filter((row) => (row[column] as string) < value);
          return builder;
        },
        eq: (column: string, value: boolean) => {
          rows = rows.filter((row) => (row[column] ?? false) === value);
          return builder;
        },
        in: (column: string, values: string[]) => {
          rows = rows.filter((row) => values.includes(row[column] as string));
          return builder;
        },
        order: () => builder,
        range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
        delete: () => ({
          in: (_column: string, values: string[]) => {
            deletedIds.push(...values);
            return Promise.resolve({ error: null });
          },
        }),
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, deletedIds };
}

const DATA: FakeData = {
  study_codes: [
    { id: 'old-empty', last_active_at: daysAgo(200) },
    { id: 'old-with-quiz', last_active_at: daysAgo(120) },
    { id: 'recent', last_active_at: daysAgo(5) },
    { id: 'just-inside', last_active_at: daysAgo(89) },
  ],
  quiz_history: [{ id: 'quiz-1', study_code_id: 'old-with-quiz' }],
};

describe('pruneStudyCodes', () => {
  it('never selects a superuser code, however inactive', async () => {
    const data: FakeData = {
      study_codes: [...DATA.study_codes, { id: 'old-superuser', last_active_at: daysAgo(400), is_superuser: true }],
      quiz_history: DATA.quiz_history,
    };
    const { client, deletedIds } = fakeSupabase(data);
    const result = await pruneStudyCodes(client, { inactiveDays: 90, noQuizzesOnly: false, write: true, now: NOW });

    expect(result.inactive).toBe(2);
    expect(deletedIds).not.toContain('old-superuser');
  });

  it('on a dry run counts what it would delete and deletes nothing', async () => {
    const { client, deletedIds } = fakeSupabase(DATA);
    const result = await pruneStudyCodes(client, { inactiveDays: 90, noQuizzesOnly: false, write: false, now: NOW });

    expect(result).toEqual({ inactive: 2, inactiveWithQuizzes: 1, selected: 2, deleted: 0 });
    expect(deletedIds).toEqual([]);
  });

  it('with --write-db deletes every inactive code, never a recent one', async () => {
    const { client, deletedIds } = fakeSupabase(DATA);
    const result = await pruneStudyCodes(client, { inactiveDays: 90, noQuizzesOnly: false, write: true, now: NOW });

    expect(result.deleted).toBe(2);
    expect([...deletedIds].sort()).toEqual(['old-empty', 'old-with-quiz']);
  });

  it('with noQuizzesOnly keeps an inactive code that has quiz history', async () => {
    const { client, deletedIds } = fakeSupabase(DATA);
    const result = await pruneStudyCodes(client, { inactiveDays: 90, noQuizzesOnly: true, write: true, now: NOW });

    expect(result).toEqual({ inactive: 2, inactiveWithQuizzes: 1, selected: 1, deleted: 1 });
    expect(deletedIds).toEqual(['old-empty']);
  });

  it('a shorter window selects more codes', async () => {
    const { client } = fakeSupabase(DATA);
    const result = await pruneStudyCodes(client, { inactiveDays: 30, noQuizzesOnly: false, write: false, now: NOW });

    expect(result.inactive).toBe(3);
  });
});

describe('db-prune-study-codes CLI', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to a dry run over 90 days', () => {
    expect(cli.parse([])).toMatchObject({ writeDb: false, inactiveDays: 90, noQuizzesOnly: false });
  });

  it('reads every flag', () => {
    expect(cli.parse(['--write-db', '--inactive-days', '30', '--no-quizzes-only'])).toMatchObject({
      writeDb: true,
      inactiveDays: 30,
      noQuizzesOnly: true,
    });
  });

  it('refuses a non-positive or non-numeric window', () => {
    expect(() => cli.parse(['--inactive-days', '0'])).toThrow(ProcessExitError);
    expect(() => cli.parse(['--inactive-days', 'abc'])).toThrow(ProcessExitError);
  });
});
