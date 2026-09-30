import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createLogger } from '../src/lib/logger';
import { applyAuditWrites } from '../src/lib/audit-write';

interface FakeResult {
  id: string;
  pass: boolean;
  isError?: boolean;
}

function makeResult(id: string, pass: boolean, isError = false): FakeResult {
  return { id, pass, isError };
}

/** Records every write, whether it came in through the batched `.upsert()` path or the per-row
 * `.update().eq()` fallback, instead of touching a real database. A batch containing any
 * `failIds` row fails as a whole (as a real upsert would), so the fallback is what actually
 * exercises per-row failure. */
function makeFakeSupabase(opts: { failIds?: Set<string> } = {}) {
  const upsertCalls: Record<string, unknown>[][] = [];
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
        upsert(rows: Record<string, unknown>[]) {
          upsertCalls.push(rows);
          if (rows.some((row) => opts.failIds?.has(row.id as string))) {
            return Promise.resolve({ error: { message: 'simulated batch failure' } });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { supabase: client as unknown as SupabaseClient, upsertCalls, updateCalls };
}

const logger = createLogger('audit-write-test');

const baseOpts = {
  logger,
  isError: (r: FakeResult) => r.isError === true,
  isGatePass: (r: FakeResult) => r.pass,
  buildMetadata: (r: FakeResult) => ({ pass: r.pass }),
};

describe('applyAuditWrites', () => {
  it('writes every valid result via a single batched upsert when nothing fails', async () => {
    const results = [makeResult('a', true), makeResult('b', false)];
    const { supabase, upsertCalls, updateCalls } = makeFakeSupabase();

    const summary = await applyAuditWrites(supabase, results, baseOpts);

    expect(summary).toEqual({ activeIds: ['a'], flaggedIds: ['b'], errorCount: 0 });
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toHaveLength(2);
    expect(updateCalls).toHaveLength(0);
  });

  it('excludes error results from the write entirely', async () => {
    const results = [makeResult('a', true), makeResult('broken', true, true)];
    const { supabase, upsertCalls } = makeFakeSupabase();

    const summary = await applyAuditWrites(supabase, results, baseOpts);

    expect(summary).toEqual({ activeIds: ['a'], flaggedIds: [], errorCount: 1 });
    expect(upsertCalls[0].map((r) => r.id)).toEqual(['a']);
  });

  // The one behavior most likely to silently regress under batching: a single bad row in a batch
  // must not take the rest of that batch down with it, matching the pre-batching per-row loop's
  // isolation.
  it('falls back to one write per row when the batch fails, so one bad row does not take down its siblings', async () => {
    const results = [makeResult('good-1', true), makeResult('bad', true), makeResult('good-2', false)];
    const { supabase, upsertCalls, updateCalls } = makeFakeSupabase({ failIds: new Set(['bad']) });

    const summary = await applyAuditWrites(supabase, results, baseOpts);

    // The batch upsert was attempted (and failed) before falling back.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].map((r) => r.id).sort()).toEqual(['bad', 'good-1', 'good-2']);

    // Every row was retried individually, and only the bad one failed.
    expect(updateCalls.map((c) => c.id).sort()).toEqual(['bad', 'good-1', 'good-2']);
    expect(summary.activeIds.sort()).toEqual(['good-1']);
    expect(summary.flaggedIds).toEqual(['good-2']);
    expect(summary.errorCount).toBe(0);
  });

  it('carries extra columns from buildExtraColumns on every row, including unchanged ones', async () => {
    const results = [makeResult('a', true), makeResult('b', false)];
    const { supabase, upsertCalls } = makeFakeSupabase();

    await applyAuditWrites(supabase, results, {
      ...baseOpts,
      buildExtraColumns: (r) => ({ difficulty: r.pass ? 'advanced' : 'beginner' }),
    });

    const byId = Object.fromEntries(upsertCalls[0].map((r) => [r.id, r]));
    expect(byId.a.difficulty).toBe('advanced');
    expect(byId.b.difficulty).toBe('beginner');
  });

  it('omits extra columns entirely when buildExtraColumns is not given (Sonnet has none)', async () => {
    const results = [makeResult('a', true)];
    const { supabase, upsertCalls } = makeFakeSupabase();

    await applyAuditWrites(supabase, results, baseOpts);

    expect(Object.keys(upsertCalls[0][0]).sort()).toEqual(['audit_metadata', 'id', 'quality_status']);
  });
});
