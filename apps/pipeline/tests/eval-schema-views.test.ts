/**
 * Asserts that `supabase/schema.sql` declares the evaluation framework's cross-cutting views and
 * the provider-name normalization function by name, so a rename or removal there fails a test
 * instead of only surfacing when a command or front-end query breaks against the live database.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/lib/paths';

const schema = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'schema.sql'), 'utf-8');

describe('supabase/schema.sql declares the evaluation framework cross-cutting views', () => {
  it('eval_normalize_provider function is declared', () => {
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION eval_normalize_provider\(/);
  });

  it('eval_run_metric_status takes five arguments, including p_scored_at', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION eval_run_metric_status\(p_status text, p_summary jsonb, p_set_id uuid, p_finished_at timestamptz, p_scored_at timestamptz\)/,
    );
  });

  it("eval_run_metric_status's comment documents the 'reference reviewed after scoring' state", () => {
    const fnStart = schema.indexOf('CREATE OR REPLACE FUNCTION eval_run_metric_status(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = schema.indexOf('$$ LANGUAGE sql STABLE', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    expect(schema.slice(fnStart, fnEnd)).toContain('reference reviewed after scoring');
  });

  it('eval_runs declares scored_at and scoring_review_round_id', () => {
    expect(schema).toMatch(/ADD COLUMN scored_at TIMESTAMPTZ/);
    expect(schema).toMatch(
      /ADD COLUMN scoring_review_round_id UUID REFERENCES eval_review_rounds\(id\) ON DELETE RESTRICT/,
    );
  });

  it.each(['eval_run_scorecard', 'eval_run_model_stats', 'eval_run_behaviour'])(
    '%s calls eval_run_metric_status with r.scored_at as the fifth argument',
    (viewName) => {
      const viewStart = schema.indexOf(`CREATE VIEW ${viewName} `);
      expect(viewStart).toBeGreaterThan(-1);
      const viewEnd = schema.indexOf(';', viewStart);
      expect(viewEnd).toBeGreaterThan(viewStart);
      expect(schema.slice(viewStart, viewEnd)).toContain(
        'eval_run_metric_status(r.status, r.summary, r.set_id, r.finished_at, r.scored_at)',
      );
    },
  );

  it.each([
    'eval_item_consensus',
    'eval_run_behaviour',
    'eval_variant_stability',
    'eval_experiment_variants',
    'eval_experiment_dependencies',
  ])('%s view is declared', (viewName) => {
    expect(schema).toMatch(new RegExp(`CREATE (OR REPLACE )?VIEW ${viewName} `));
  });

  it('eval_run_model_stats.provider_mismatch_count is normalized through eval_normalize_provider', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_run_model_stats');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf('CREATE VIEW eval_family_history');
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain('eval_normalize_provider(res.served_provider, false)');
    expect(viewBody).toContain('eval_normalize_provider(r.provider_pin, true)');
  });

  it('eval_items declares seeded_class', () => {
    const tableStart = schema.indexOf('CREATE TABLE eval_items');
    expect(tableStart).toBeGreaterThan(-1);
    const tableEnd = schema.indexOf('CREATE INDEX idx_eval_items_set');
    expect(tableEnd).toBeGreaterThan(tableStart);
    expect(schema.slice(tableStart, tableEnd)).toMatch(/seeded_class\s+TEXT/);
  });

  it('eval_item_consensus exposes seeded_class', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_item_consensus');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf(';', viewStart);
    expect(viewEnd).toBeGreaterThan(viewStart);
    expect(schema.slice(viewStart, viewEnd)).toContain('ei.seeded_class');
  });

  it.each(['eval_hypothesis_classes', 'eval_experiment_hypotheses', 'legacy_code'])(
    '%s is retired and no longer declared',
    (name) => {
      expect(schema).not.toContain(name);
    },
  );
});
