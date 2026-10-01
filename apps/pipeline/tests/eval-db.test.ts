import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabaseEvalStore,
  type EvalSetRow,
  type NewEvalSetRow,
  type EvalItemRow,
  type NewEvalItemRow,
  type EvalRunRow,
  type NewEvalRunRow,
  type EvalExperimentRow,
} from '../src/lib/eval/db';

/**
 * A minimal in-memory stand-in for the Supabase query builder, covering exactly the chains
 * db.ts's functions use (`insert().select().single()`, `insert().select()`, `select().eq()...`,
 * `select().eq().maybeSingle()`, `select().or().maybeSingle()`, `update().eq()`) — not a
 * general-purpose Supabase mock. `.or()` only understands the exact
 * `id.eq.<value>,slug.eq.<value>` shape `getExperiment` builds, matched via a small regex rather
 * than a real PostgREST filter-string parser.
 */
function makeFakeEvalSupabase() {
  const tables: Record<string, Record<string, unknown>[]> = {
    eval_sets: [], eval_items: [], eval_runs: [], eval_results: [], eval_experiments: [],
  };
  let nextId = 1;

  function from(table: string) {
    const rows = tables[table];

    return {
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        const list = Array.isArray(payload) ? payload : [payload];
        const inserted = list.map((r) => ({ id: `${table}-${nextId++}`, created_at: 'now', updated_at: 'now', ...r }));
        rows.push(...inserted);
        return {
          select: () => ({
            single: async () => ({ data: inserted[0], error: null }),
            then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: inserted, error: null }),
          }),
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        };
      },
      select() {
        let filtered = rows;
        const builder = {
          eq(col: string, val: unknown) {
            filtered = filtered.filter((r) => r[col] === val);
            return builder;
          },
          or(filterExpr: string) {
            const match = filterExpr.match(/^id\.eq\.(.+),slug\.eq\.(.+)$/);
            if (!match) throw new Error(`unsupported .or() filter in fake: ${filterExpr}`);
            const [, idValue, slugValue] = match;
            filtered = filtered.filter((r) => r.id === idValue || r.slug === slugValue);
            return builder;
          },
          order: () => builder,
          maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
          then: (resolve: (v: { data: unknown; error: null }) => void) => resolve({ data: filtered, error: null }),
        };
        return builder;
      },
      update(patch: Record<string, unknown>) {
        return {
          eq: async (col: string, val: unknown) => {
            const idx = rows.findIndex((r) => r[col] === val);
            if (idx >= 0) rows[idx] = { ...rows[idx], ...patch };
            return { error: null };
          },
        };
      },
    };
  }

  return { supabase: { from } as unknown as SupabaseClient, tables };
}

function makeExperimentRow(overrides: Partial<EvalExperimentRow> = {}): EvalExperimentRow {
  return {
    id: '3f6e1c9a-4b2d-4a7e-9c1f-2d8b5a6e7f10',
    slug: 'sonnet-vs-opus-grading',
    legacy_code: null,
    question: 'Does the candidate model grade as well as baseline?',
    tasks: ['grading'],
    variants_declared: [],
    decision_rule: {},
    depends_on: [],
    status: 'proposed',
    decided_at: null,
    notes: null,
    created_at: '2026-09-29T00:00:00Z',
    updated_at: '2026-09-29T00:00:00Z',
    ...overrides,
  } as EvalExperimentRow;
}

/** The fake's `tables` map is typed as generic rows; `getExperiment` tests seed it with a real
 * `EvalExperimentRow`, which has no index signature of its own. */
function pushExperiment(tables: Record<string, Record<string, unknown>[]>, row: EvalExperimentRow): void {
  tables.eval_experiments.push(row as unknown as Record<string, unknown>);
}

describe('createSupabaseEvalStore', () => {
  it('round-trips an eval_sets row through insertSet/getSet', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);

    const newSet: NewEvalSetRow = { task: 'audit', source: 'batch-1', item_count: 150, label: 'unit-1 audit' };
    const inserted: EvalSetRow = await store.insertSet(newSet);
    expect(inserted.task).toBe('audit');
    expect(inserted.id).toBeTruthy();

    const fetched = await store.getSet(inserted.id);
    expect(fetched).toEqual(inserted);
  });

  it('returns null from getSet for an unknown id', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    expect(await store.getSet('nope')).toBeNull();
  });

  it('inserts and lists eval_items for a set', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    const set = await store.insertSet({ task: 'grading', source: 'batch-1' });

    const newItems: NewEvalItemRow[] = [
      { set_id: set.id, item_key: 'q-1:correct', payload: { label_class: 'correct' } },
      { set_id: set.id, item_key: 'q-1:wrong', payload: { label_class: 'wrong' } },
    ];
    const inserted: EvalItemRow[] = await store.insertItems(newItems);
    expect(inserted).toHaveLength(2);

    const listed = await store.listItems(set.id);
    expect(listed.map((i) => i.item_key).sort()).toEqual(['q-1:correct', 'q-1:wrong']);
  });

  it('writes seeded_class through insertItems', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    const set = await store.insertSet({ task: 'grading', source: 'batch-1' });

    const [inserted] = await store.insertItems([
      { set_id: set.id, item_key: 'q-1:correct', payload: { label_class: 'correct' }, seeded_class: 'correct' },
    ]);
    expect(inserted.seeded_class).toBe('correct');

    const [listed] = await store.listItems(set.id);
    expect(listed.seeded_class).toBe('correct');
  });

  it('returns an empty array from insertItems for an empty input, without touching the table', async () => {
    const { supabase, tables } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    expect(await store.insertItems([])).toEqual([]);
    expect(tables.eval_items).toHaveLength(0);
  });

  it('round-trips an eval_runs row through insertRun/getRun/updateRun', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    const set = await store.insertSet({ task: 'audit', source: 'batch-1' });

    const newRun: NewEvalRunRow = { set_id: set.id, task: 'audit', model: 'mistralai/mistral-large-2512' };
    const run: EvalRunRow = await store.insertRun(newRun);
    expect(run.status).toBeUndefined(); // no default applied by the fake; a real DEFAULT would set 'running'

    await store.updateRun(run.id, { status: 'completed', summary: { itemCount: 5 } });
    const updated = await store.getRun(run.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.summary).toEqual({ itemCount: 5 });
  });

  it('inserts and lists eval_results for a run', async () => {
    const { supabase } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    const set = await store.insertSet({ task: 'audit', source: 'batch-1' });
    const run = await store.insertRun({ set_id: set.id, task: 'audit', model: 'm' });
    const items = await store.insertItems([{ set_id: set.id, item_key: 'q-1', payload: {} }]);

    await store.insertResults([{ run_id: run.id, item_id: items[0].id, score: 1, error: null }]);
    const results = await store.listResults(run.id);
    expect(results).toHaveLength(1);
    expect(results[0].item_id).toBe(items[0].id);
  });

  it('is a no-op for insertResults with an empty array', async () => {
    const { supabase, tables } = makeFakeEvalSupabase();
    const store = createSupabaseEvalStore(supabase);
    await store.insertResults([]);
    expect(tables.eval_results).toHaveLength(0);
  });

  describe('getExperiment', () => {
    it('resolves by slug', async () => {
      const { supabase, tables } = makeFakeEvalSupabase();
      pushExperiment(tables, makeExperimentRow());
      const store = createSupabaseEvalStore(supabase);

      const found = await store.getExperiment('sonnet-vs-opus-grading');
      expect(found?.id).toBe('3f6e1c9a-4b2d-4a7e-9c1f-2d8b5a6e7f10');
    });

    it('resolves by row id (a UUID-shaped value, not just its slug)', async () => {
      const { supabase, tables } = makeFakeEvalSupabase();
      pushExperiment(tables, makeExperimentRow());
      const store = createSupabaseEvalStore(supabase);

      const found = await store.getExperiment('3f6e1c9a-4b2d-4a7e-9c1f-2d8b5a6e7f10');
      expect(found?.slug).toBe('sonnet-vs-opus-grading');
    });

    it('returns null for an unknown slug', async () => {
      const { supabase, tables } = makeFakeEvalSupabase();
      pushExperiment(tables, makeExperimentRow());
      const store = createSupabaseEvalStore(supabase);

      expect(await store.getExperiment('nonexistent-experiment')).toBeNull();
    });

    it('returns null for a UUID-shaped value that matches no row, rather than falling through to a different one', async () => {
      const { supabase, tables } = makeFakeEvalSupabase();
      pushExperiment(tables, makeExperimentRow());
      const store = createSupabaseEvalStore(supabase);

      expect(await store.getExperiment('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('does not attempt an id lookup for a non-UUID-shaped slug (avoids a Postgres id-column type error)', async () => {
      const { supabase, tables } = makeFakeEvalSupabase();
      // A slug that happens to share no characters with a UUID pattern; exercises the .eq()-only
      // branch of getExperiment rather than .or(), which would throw in the fake on a malformed
      // filter if the id branch were taken by mistake.
      pushExperiment(tables, makeExperimentRow({ slug: 'baseline-vs-gemini' }));
      const store = createSupabaseEvalStore(supabase);

      const found = await store.getExperiment('baseline-vs-gemini');
      expect(found?.slug).toBe('baseline-vs-gemini');
    });
  });
});
