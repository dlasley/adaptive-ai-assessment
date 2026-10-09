import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../src/lib/logger';
import { applyAuditWrites } from '../src/lib/audit-write';

interface FakeResult {
  id: string;
  pass: boolean;
  isError?: boolean;
}

function makeResult(id: string, pass: boolean, isError = false): FakeResult {
  return { id, pass, isError };
}

/** Records every `.update(data).eq('id', id)` call instead of touching a real database. A row
 * whose id is in `failIds` returns an error from that call, as a failed Postgres write would. */
function makeFakeSupabase(opts: { failIds?: Set<string> } = {}) {
  const updateCalls: { id: string; data: Record<string, unknown> }[] = [];
  const client = {
    from() {
      return {
        update(data: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updateCalls.push({ id, data });
              if (opts.failIds?.has(id)) {
                return Promise.resolve({ error: { message: `simulated failure for ${id}` } });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { supabase: client as unknown as SupabaseClient, updateCalls };
}

function makeFakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function baseOpts(logger: Logger) {
  return {
    logger,
    isError: (r: FakeResult) => r.isError === true,
    isGatePass: (r: FakeResult) => r.pass,
    buildMetadata: (r: FakeResult) => ({ pass: r.pass }),
  };
}

describe('applyAuditWrites', () => {
  it('writes every valid result via one update().eq() call per row, with the right quality_status and audit_metadata', async () => {
    const results = [makeResult('a', true), makeResult('b', false)];
    const { supabase, updateCalls } = makeFakeSupabase();

    const summary = await applyAuditWrites(supabase, results, baseOpts(makeFakeLogger()));

    expect(summary).toEqual({ activeIds: ['a'], flaggedIds: ['b'], errorCount: 0 });
    expect(updateCalls).toHaveLength(2);
    const byId = Object.fromEntries(updateCalls.map((c) => [c.id, c.data]));
    expect(byId.a).toEqual({ quality_status: 'active', audit_metadata: { pass: true } });
    expect(byId.b).toEqual({ quality_status: 'flagged', audit_metadata: { pass: false } });
  });

  it('excludes error results from the write entirely', async () => {
    const results = [makeResult('a', true), makeResult('broken', true, true)];
    const { supabase, updateCalls } = makeFakeSupabase();

    const summary = await applyAuditWrites(supabase, results, baseOpts(makeFakeLogger()));

    expect(summary).toEqual({ activeIds: ['a'], flaggedIds: [], errorCount: 1 });
    expect(updateCalls.map((c) => c.id)).toEqual(['a']);
  });

  it('logs and skips a row whose update fails, while its siblings still write and land in the result', async () => {
    const results = [makeResult('good-1', true), makeResult('bad', true), makeResult('good-2', false)];
    const logger = makeFakeLogger();
    const { supabase, updateCalls } = makeFakeSupabase({ failIds: new Set(['bad']) });

    const summary = await applyAuditWrites(supabase, results, baseOpts(logger));

    // Every row was attempted, in order.
    expect(updateCalls.map((c) => c.id)).toEqual(['good-1', 'bad', 'good-2']);

    // Only the failing row was logged, and only it is missing from the returned ids.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect((logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('bad');
    expect(summary.activeIds).toEqual(['good-1']);
    expect(summary.flaggedIds).toEqual(['good-2']);
    expect(summary.errorCount).toBe(0);
  });

  it('carries extra columns from buildExtraColumns on the rows that return them', async () => {
    const results = [makeResult('a', true), makeResult('b', false)];
    const { supabase, updateCalls } = makeFakeSupabase();

    await applyAuditWrites(supabase, results, {
      ...baseOpts(makeFakeLogger()),
      buildExtraColumns: (r) => (r.pass ? { difficulty: 'advanced' } : {}),
    });

    const byId = Object.fromEntries(updateCalls.map((c) => [c.id, c.data]));
    expect(byId.a.difficulty).toBe('advanced');
    expect('difficulty' in byId.b).toBe(false);
  });

  it('omits extra columns entirely when buildExtraColumns is not given (Sonnet has none)', async () => {
    const results = [makeResult('a', true)];
    const { supabase, updateCalls } = makeFakeSupabase();

    await applyAuditWrites(supabase, results, baseOpts(makeFakeLogger()));

    expect(Object.keys(updateCalls[0].data).sort()).toEqual(['audit_metadata', 'quality_status']);
  });
});
