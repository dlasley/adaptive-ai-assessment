/**
 * Proves that the two SQL views which mirror TypeScript rules give the same membership as that
 * TypeScript, on the rows that exist: `eval_experiment_variants.run_ids` against
 * `declaredVariantMatchesRun` for every declared variant of every experiment, and
 * `eval_variant_stability.run_ids` against the groups `normalizeRepeatIdentitySettings` forms over
 * every run that is neither failed nor aborted. Compares which runs are in each group, not how many.
 *
 * Needs a live connection to the test database. Skipped unless RUN_DB_TESTS=1 is set, so `npm test`
 * and CI never touch a database. When set, also requires NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SECRET_KEY pointed at the test project; the test refuses to run against any other host.
 */

import { describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getExpectedTestDbHost } from '../../../tests/credential-guard';
import {
  declaredVariantMatchesRun,
  normalizeRepeatIdentitySettings,
  type DeclaredVariant,
} from '../src/commands/eval-run';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const PAGE_SIZE = 500;

interface RunRow {
  id: string;
  task: 'audit' | 'grading' | 'mapping' | 'transcription';
  model: string;
  status: string;
  experiment_id: string | null;
  set_id: string;
  prompt_hash: string | null;
  settings: Record<string, unknown>;
}

/** Pages through `table` ordered by `orderBy` (one column, or several applied in sequence), whose
 * combined values must be unique per row when a table can exceed one page. */
async function fetchAll<T>(supabase: SupabaseClient, table: string, columns: string, orderBy: string | string[]): Promise<T[]> {
  const orderColumns = Array.isArray(orderBy) ? orderBy : [orderBy];
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns);
    for (const column of orderColumns) query = query.order(column);
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

const sortedIds = (ids: readonly string[]) => [...ids].sort();

describe.skipIf(!RUN_DB_TESTS)('eval view membership matches its TypeScript twin (real database)', () => {
  async function connect(): Promise<SupabaseClient> {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!url || !secretKey) {
      throw new Error('RUN_DB_TESTS=1 requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (test project credentials)');
    }
    if (!url.includes(getExpectedTestDbHost())) {
      throw new Error(`refusing to run against a non-test database host: ${url}`);
    }
    return createClient(url, secretKey);
  }

  it('eval_experiment_variants.run_ids equals the runs declaredVariantMatchesRun attributes to each declared variant', async () => {
    const supabase = await connect();
    const runs = await fetchAll<RunRow>(supabase, 'eval_runs', 'id, task, model, status, experiment_id, set_id, prompt_hash, settings', 'id');
    const experiments = await fetchAll<{ id: string; slug: string; variants_declared: DeclaredVariant[] }>(supabase, 'eval_experiments', 'id, slug, variants_declared', 'id');
    const viewRows = await fetchAll<{ experiment_id: string; declared_label: string; run_ids: string[] }>(supabase, 'eval_experiment_variants', 'experiment_id, declared_label, run_ids', ['experiment_id', 'declared_label']);
    const experimentIdBySlug = new Map(experiments.map((e) => [e.slug, e.id]));

    const mismatches: string[] = [];
    let compared = 0;
    for (const experiment of experiments) {
      for (const declared of experiment.variants_declared) {
        const viewRow = viewRows.find((r) => r.experiment_id === experiment.id && r.declared_label === declared.label);
        if (!viewRow) {
          mismatches.push(`${experiment.slug} / ${declared.label}: no row in eval_experiment_variants`);
          continue;
        }
        const matched = runs
          .filter((run) => declaredVariantMatchesRun(declared, run as never, { declaringExperimentId: experiment.id, experimentIdBySlug }))
          .map((run) => run.id);
        compared += 1;
        if (JSON.stringify(sortedIds(matched)) !== JSON.stringify(sortedIds(viewRow.run_ids))) {
          mismatches.push(`${experiment.slug} / ${declared.label}: TypeScript ${JSON.stringify(sortedIds(matched))}, view ${JSON.stringify(sortedIds(viewRow.run_ids))}`);
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(mismatches).toEqual([]);
  });

  it('eval_variant_stability.run_ids equals the groups normalizeRepeatIdentitySettings forms over every non-failed, non-aborted run', async () => {
    const supabase = await connect();
    const runs = await fetchAll<RunRow>(supabase, 'eval_runs', 'id, task, model, status, experiment_id, set_id, prompt_hash, settings', 'id');
    const viewRows = await fetchAll<{ run_ids: string[] }>(supabase, 'eval_variant_stability', 'run_ids', 'run_ids');

    const groups = new Map<string, string[]>();
    for (const run of runs) {
      if (run.status === 'failed' || run.status === 'aborted') continue;
      const key = JSON.stringify(canonical([
        run.experiment_id, run.set_id, run.model, run.prompt_hash, normalizeRepeatIdentitySettings(run.settings, run.task),
      ]));
      groups.set(key, [...(groups.get(key) ?? []), run.id]);
    }

    const fromTypeScript = [...groups.values()].map((ids) => JSON.stringify(sortedIds(ids))).sort();
    const fromView = viewRows.map((r) => JSON.stringify(sortedIds(r.run_ids))).sort();
    expect(fromTypeScript.length).toBeGreaterThan(0);
    expect(fromView).toEqual(fromTypeScript);
  });
});
