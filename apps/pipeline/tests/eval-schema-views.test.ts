/**
 * Asserts that `supabase/schema.sql` declares the evaluation framework's cross-cutting views and
 * the provider-name normalization function by name, so a rename or removal there fails a test
 * instead of only surfacing when a command or front-end query breaks against the live database.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../src/lib/paths';
import { DEFAULT_RENDER_DPI } from '../src/lib/pdf-conversion';
import { AUDIT_GROUP_SIZE } from '../src/lib/pipeline-config';
import { DEFAULT_RUN_GROUPING, DEFAULT_RUN_MODE } from '../src/commands/eval-run';

const schema = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'schema.sql'), 'utf-8');

describe('supabase/schema.sql declares the evaluation framework cross-cutting views', () => {
  it('eval_normalize_provider function is declared', () => {
    expect(schema).toMatch(/CREATE (OR REPLACE )?FUNCTION eval_normalize_provider\(/);
  });

  it('eval_run_metric_status takes six arguments, including p_scored_at and p_scoring_review_round_id', () => {
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION eval_run_metric_status\(p_status text, p_summary jsonb, p_set_id uuid, p_finished_at timestamptz, p_scored_at timestamptz, p_scoring_review_round_id uuid\)/,
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
    '%s calls eval_run_metric_status with r.scored_at and r.scoring_review_round_id',
    (viewName) => {
      const viewStart = schema.indexOf(`CREATE VIEW ${viewName} `);
      expect(viewStart).toBeGreaterThan(-1);
      const viewEnd = schema.indexOf(';', viewStart);
      expect(viewEnd).toBeGreaterThan(viewStart);
      expect(schema.slice(viewStart, viewEnd)).toContain(
        'eval_run_metric_status(r.status, r.summary, r.set_id, r.finished_at, r.scored_at, r.scoring_review_round_id)',
      );
    },
  );

  it('eval_run_scorecard exposes scored_at and scoring_review_round_id as columns', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_run_scorecard ');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf(';', viewStart);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    // r.scored_at/r.scoring_review_round_id also appear as function arguments earlier in the
    // SELECT list; this checks they are additionally selected as their own output columns, appended
    // after metric_status so CREATE OR REPLACE VIEW can add them without reordering existing ones.
    expect(viewBody).toMatch(/AS metric_status,\s*\n\s*r\.scored_at,\s*\n\s*r\.scoring_review_round_id/);
  });

  it('both eval_run_metric_status and eval_normalize_provider carry a COMMENT ON FUNCTION', () => {
    expect(schema).toContain("COMMENT ON FUNCTION eval_run_metric_status(text, jsonb, uuid, timestamptz, timestamptz, uuid) IS");
    expect(schema).toContain('COMMENT ON FUNCTION eval_normalize_provider(text, boolean) IS');
  });

  it.each([
    'eval_item_consensus',
    'eval_run_behaviour',
    'eval_variant_stability',
    'eval_experiment_variants',
    'eval_experiment_dependencies',
  ])('%s view is declared', (viewName) => {
    expect(schema).toMatch(new RegExp(`CREATE (OR REPLACE )?VIEW ${viewName} `));
  });

  it('eval_result_verdict function is declared and compares transcription on the no-content marker alone, not a score band', () => {
    const fnStart = schema.indexOf('CREATE OR REPLACE FUNCTION eval_result_verdict(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = schema.indexOf('$$ LANGUAGE sql IMMUTABLE', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = schema.slice(fnStart, fnEnd);
    const transcriptionBranchStart = body.indexOf("WHEN 'transcription' THEN");
    expect(transcriptionBranchStart).toBeGreaterThan(-1);
    const branch = body.slice(transcriptionBranchStart);
    expect(branch).toContain('no_content_marker');
    expect(branch).not.toContain('score_band');
    expect(branch).not.toMatch(/round\(p_output/);
  });

  it('eval_result_verdict carries a COMMENT ON FUNCTION', () => {
    expect(schema).toContain('COMMENT ON FUNCTION eval_result_verdict(text, jsonb, jsonb) IS');
  });

  it.each(['eval_item_consensus', 'eval_run_pair_agreement'])(
    '%s calls eval_result_verdict rather than its own inline CASE',
    (viewName) => {
      const viewStart = schema.indexOf(`CREATE VIEW ${viewName} `);
      expect(viewStart).toBeGreaterThan(-1);
      const viewEnd = schema.indexOf(';', viewStart);
      expect(viewEnd).toBeGreaterThan(viewStart);
      const viewBody = schema.slice(viewStart, viewEnd);
      expect(viewBody).toContain('eval_result_verdict(');
      expect(viewBody).not.toMatch(/WHEN 'grading' THEN jsonb_build_object\('is_correct'/);
    },
  );

  it.each(['eval_overview', 'eval_experiment_summary', 'eval_findings_current', 'eval_run_pair_agreement'])(
    '%s view is declared',
    (viewName) => {
      expect(schema).toMatch(new RegExp(`CREATE (OR REPLACE )?VIEW ${viewName} `));
    },
  );

  it('eval_findings_current walks the supersedes_finding_id chain recursively and collapses to the head', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_findings_current');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf('COMMENT ON VIEW eval_findings_current', viewStart);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain('WITH RECURSIVE chain AS');
    expect(viewBody).toContain('NOT EXISTS (SELECT 1 FROM eval_findings s WHERE s.supersedes_finding_id = f.id)');
    expect(viewBody).toContain('superseded_finding_ids');
  });

  it('eval_experiment_summary reads eval_experiment_variants and eval_experiment_dependencies rather than re-deriving their matching rules', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_experiment_summary');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf(';', viewStart);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain('FROM eval_experiment_variants v');
    expect(viewBody).toContain('FROM eval_experiment_dependencies d');
    expect(viewBody).toContain("d.depends_on_status <> 'decided'");
  });

  it('eval_overview counts every table and status/kind split named in the brief', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_overview');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf(';', viewStart);
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    for (const table of ['eval_sets', 'eval_items', 'eval_runs', 'eval_results', 'eval_experiments', 'eval_findings', 'eval_models_current']) {
      expect(viewBody).toContain(`FROM ${table}`);
    }
  });

  it('eval_experiment_variants declares an ambiguous column and matches on declared settings, not model alone', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_experiment_variants');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_dependencies');
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toMatch(/AS\s+ambiguous/);
    expect(viewBody).toContain("va.declared_settings ? 'groupSize'");
    expect(viewBody).toContain("r.status NOT IN ('failed', 'aborted')");
  });

  it('eval_experiment_variants compares exclusionPass by classifier model slug only, on both the run and the declared side', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_dependencies');
    const viewBody = schema.slice(viewStart, viewEnd);
    // Reduced on the run's own stored settings (an object: {model, provider, promptHash})...
    expect(viewBody).toContain("r.settings -> 'exclusionPass' -> 'model'");
    // ...and on the declared value (a bare model-slug string), the same way.
    expect(viewBody).toContain("va.declared_settings -> 'exclusionPass' -> 'model'");
    // eval_variant_stability stays the untouched twin of the TypeScript normalizer.
    const stabilityStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    const stabilityBody = schema.slice(stabilityStart, viewStart);
    expect(stabilityBody).toContain("COALESCE(r.settings -> 'exclusionPass', 'null'::jsonb)");
    expect(stabilityBody).not.toContain("'exclusionPass' -> 'model'");
  });

  it("eval_variant_stability's status filter excludes only failed/aborted runs, matching resolveExistingRepeatCount", () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    expect(viewStart).toBeGreaterThan(-1);
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_variants');
    expect(viewEnd).toBeGreaterThan(viewStart);
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain("r.status NOT IN ('failed', 'aborted')");
  });

  it("eval_variant_stability's renderDpi default matches DEFAULT_RENDER_DPI", () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewBody = schema.slice(viewStart, viewEnd);
    const match = viewBody.match(/COALESCE\(r\.settings -> 'renderDpi', '(\d+)'::jsonb\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(DEFAULT_RENDER_DPI);
  });

  it("eval_variant_stability's groupSize default matches the audit task's default (AUDIT_GROUP_SIZE); the view does not branch by task, so this only catches a drift in the shared numeric literal, not a per-task divergence", () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewBody = schema.slice(viewStart, viewEnd);
    const match = viewBody.match(/COALESCE\(r\.settings -> 'groupSize', '(\d+)'::jsonb\)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(AUDIT_GROUP_SIZE);
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

  it("eval_variant_stability and eval_experiment_variants default mode and grouping to the normalizer's own defaults", () => {
    const stabilityStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    const variantsStart = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const variantsEnd = schema.indexOf('CREATE VIEW eval_experiment_dependencies');
    for (const body of [schema.slice(stabilityStart, variantsStart), schema.slice(variantsStart, variantsEnd)]) {
      expect(body).toContain(`COALESCE(r.settings -> 'mode', '"${DEFAULT_RUN_MODE}"'::jsonb)`);
      expect(body).toContain(`COALESCE(r.settings -> 'grouping', '"${DEFAULT_RUN_GROUPING}"'::jsonb)`);
    }
  });

  it('eval_variant_stability exposes mode and grouping after render_dpi and groups by them', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_variant_stability');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toMatch(/AS render_dpi,\s*\n\s*norm_mode\s+AS mode,\s*\n\s*norm_grouping\s+AS grouping,\s*\n\s*count\(\*\)/);
    expect(viewBody).toMatch(/GROUP BY[^;]*norm_mode, norm_grouping;/);
  });

  it('eval_experiment_variants matches a declared mode and grouping', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_dependencies');
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain("va.declared_settings ? 'mode'");
    expect(viewBody).toContain("va.declared_settings ? 'grouping'");
  });

  it('eval_experiment_variants draws on the experiment named by baseline_from and exposes it as runs_from_slug after run_ids', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_experiment_variants');
    const viewEnd = schema.indexOf('CREATE VIEW eval_experiment_dependencies');
    const viewBody = schema.slice(viewStart, viewEnd);
    expect(viewBody).toContain("v.declared ->> 'baseline_from'");
    expect(viewBody).toContain('ON ri.experiment_id = va.candidate_experiment_id');
    expect(viewBody).toMatch(/AS run_ids,\s*\n\s*va\.baseline_from\s+AS runs_from_slug\s*\nFROM variants va/);
  });

  it('eval_findings_current is created before eval_experiment_summary, which reads it for current findings', () => {
    const findingsStart = schema.indexOf('CREATE VIEW eval_findings_current');
    const summaryStart = schema.indexOf('CREATE VIEW eval_experiment_summary');
    expect(findingsStart).toBeGreaterThan(-1);
    expect(summaryStart).toBeGreaterThan(findingsStart);
    const summaryBody = schema.slice(summaryStart, schema.indexOf(';', summaryStart));
    expect(summaryBody).toContain('FROM eval_findings_current c WHERE c.experiment_id = e.id) AS current_finding_count');
    expect(summaryBody).toMatch(/FROM eval_findings_current c\s*\n\s*WHERE c\.experiment_id = e\.id\s*\n\s*ORDER BY c\.decided_at DESC/);
    expect(summaryBody).toContain('FROM eval_findings f WHERE f.experiment_id = e.id) AS finding_count');
  });

  it('eval_run_pair_agreement names one verdict_kind per task, taken from eval_result_verdict branches', () => {
    const viewStart = schema.indexOf('CREATE VIEW eval_run_pair_agreement');
    const viewBody = schema.slice(viewStart, schema.indexOf(';', viewStart));
    for (const [task, kind] of [['grading', 'is_correct'], ['audit', 'gate_criteria'], ['mapping', 'headings'], ['transcription', 'no_content_marker']]) {
      expect(viewBody).toContain(`WHEN '${task}' THEN '${kind}'`);
    }
    expect(viewBody).toMatch(/AS verdict_kind/);
  });

  it('every COMMENT ON for an eval_* object is a COMMENT ON statement, none in the schema file carries an em dash', () => {
    const commentLines = schema.split('\n').filter((line) => /^COMMENT ON .* eval_/.test(line));
    expect(commentLines.length).toBeGreaterThan(0);
    expect(commentLines.filter((line) => line.includes(String.fromCharCode(0x2014)))).toEqual([]);
  });

  it('eval_runs.scoring_review_round_id carries a COMMENT ON COLUMN statement', () => {
    expect(schema).toContain('COMMENT ON COLUMN eval_runs.scoring_review_round_id IS');
  });
});
