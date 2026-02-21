/**
 * N-Cohort Experiment Comparison
 *
 * Replaces the hardcoded compare-cohorts.ts with a dynamic N-cohort abstraction.
 * Reads cohort data from experiment_questions, computes metrics, generates report,
 * and writes results back to the experiments table.
 *
 * Usage:
 *   npx tsx scripts/compare-experiments.ts --experiment <uuid>
 *   npx tsx scripts/compare-experiments.ts --experiment <uuid> --export data/out.json
 *   npx tsx scripts/compare-experiments.ts --experiment <uuid> --report docs/report.md
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { createScriptSupabase, fetchAllPages } from './lib/db-queries';

// ── Types ──────────────────────────────────────────────────────────────

interface CLIOptions {
  experimentId: string;
  exportPath?: string;
  reportPath?: string;
}

interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  batch_id: string | null;
  source_file: string | null;
  quality_status: string;
  audit_metadata: any;
  content_hash: string;
  generated_by: string | null;
  cohort: string;
}

interface Stage2Metrics {
  validation_pass_rate: number;
  structural_rejected: number;
  validation_rejected: number;
  type_drift: number;
  meta_filtered: number;
  difficulty_relabeled: number;
}

interface CohortMetrics {
  cohort: string;
  total: number;
  gate_pass_count: number;
  gate_pass_rate: number;
  gate_fail_breakdown: Record<string, number>;
  difficulty_mismatch_count: number;
  difficulty_mismatch_rate: number;
  stage2_metrics: Stage2Metrics | null;
  topic_coverage: string[];
  type_distribution: Record<string, number>;
  severity_distribution: Record<string, number>;
}

interface ExperimentRecord {
  id: string;
  name: string;
  unit_id: string;
  research_question: string;
  hypothesis: string;
  independent_variable: string;
  primary_metric: string;
  description: string | null;
  cohorts: any[];
  git_branch: string | null;
  git_commit: string | null;
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { experimentId: '' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--experiment':
        options.experimentId = args[++i];
        break;
      case '--export':
        options.exportPath = args[++i];
        break;
      case '--report':
        options.reportPath = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`
N-Cohort Experiment Comparison

Usage:
  npx tsx scripts/compare-experiments.ts --experiment <uuid> [options]

Required:
  --experiment <uuid>   Experiment ID to compare

Optional:
  --export <path>       Export JSON data
  --report <path>       Generate markdown report
  --help, -h            Show this help
`);
        process.exit(0);
    }
  }

  if (!options.experimentId) {
    console.error('Error: --experiment is required');
    process.exit(1);
  }

  return options;
}

// ── Data fetching ──────────────────────────────────────────────────────

async function fetchBatchMetrics(
  supabase: SupabaseClient,
  batchId: string,
  tableName: string,
): Promise<Stage2Metrics | null> {
  const { data } = await supabase
    .from(tableName)
    .select('quality_metrics')
    .eq('id', batchId)
    .single();

  return data?.quality_metrics ?? null;
}

// ── Metric computation (reused from compare-cohorts.ts) ────────────────

const GATE_CRITERIA = [
  'answer_correct',
  'grammar_correct',
  'no_hallucination',
  'question_coherent',
  'natural_french',
  'register_appropriate',
];

function computeMetrics(cohortLabel: string, questions: QuestionRow[]): CohortMetrics {
  const gateFails: Record<string, number> = {};
  for (const c of GATE_CRITERIA) gateFails[c] = 0;

  let gatePassCount = 0;
  let diffMismatchCount = 0;

  const severityDist: Record<string, number> = { critical: 0, minor: 0, suggestion: 0 };
  const typeDist: Record<string, number> = {};
  const topicSet = new Set<string>();

  for (const q of questions) {
    typeDist[q.type] = (typeDist[q.type] || 0) + 1;
    if (q.topic) topicSet.add(q.topic);

    const gate = q.audit_metadata?.gate_criteria;
    if (gate) {
      let allPass = true;
      for (const c of GATE_CRITERIA) {
        if (gate[c] === false) {
          gateFails[c]++;
          allPass = false;
        }
      }
      if (allPass) gatePassCount++;
    } else {
      gatePassCount++;
    }

    if (q.audit_metadata?.soft_signals?.difficulty_appropriate === false) {
      diffMismatchCount++;
    }

    const sev = q.audit_metadata?.severity;
    if (sev && sev in severityDist) {
      severityDist[sev]++;
    }
  }

  return {
    cohort: cohortLabel,
    total: questions.length,
    gate_pass_count: gatePassCount,
    gate_pass_rate: questions.length > 0 ? gatePassCount / questions.length : 0,
    gate_fail_breakdown: gateFails,
    difficulty_mismatch_count: diffMismatchCount,
    difficulty_mismatch_rate: questions.length > 0 ? diffMismatchCount / questions.length : 0,
    stage2_metrics: null,
    topic_coverage: [...topicSet].sort(),
    type_distribution: typeDist,
    severity_distribution: severityDist,
  };
}

function computePairwiseOverlap(
  cohorts: Map<string, QuestionRow[]>,
): Map<string, number> {
  const labels = [...cohorts.keys()];
  const hashSets = new Map<string, Set<string>>();
  for (const [label, questions] of cohorts) {
    hashSets.set(label, new Set(questions.map(q => q.content_hash).filter(Boolean)));
  }

  const overlaps = new Map<string, number>();
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const setA = hashSets.get(labels[i])!;
      const setB = hashSets.get(labels[j])!;
      let count = 0;
      for (const hash of setA) {
        if (setB.has(hash)) count++;
      }
      overlaps.set(`${labels[i]}/${labels[j]}`, count);
    }
  }

  return overlaps;
}

// ── Report helpers ─────────────────────────────────────────────────────

function pct(n: number): string {
  return (n * 100).toFixed(1);
}

function failRate(count: number, total: number): string {
  return total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
}

function deltaStr(a: number, b: number): string {
  const d = ((b - a) * 100).toFixed(1);
  return parseFloat(d) >= 0 ? `+${d}` : d;
}

// ── N-cohort report generation ─────────────────────────────────────────

function generateMarkdownReport(
  experiment: ExperimentRecord,
  allMetrics: CohortMetrics[],
  overlaps: Map<string, number>,
): string {
  const lines: string[] = [];
  const line = (s: string) => lines.push(s);
  const controlMetrics = allMetrics.find(m => m.cohort === 'control');
  const treatmentMetrics = allMetrics.filter(m => m.cohort !== 'control');

  line(`# Experiment Report: ${experiment.name}`);
  line('');
  line(`**Generated**: ${new Date().toISOString()}`);
  line(`**Experiment ID**: ${experiment.id}`);
  line(`**Unit**: ${experiment.unit_id}`);
  if (experiment.git_branch) {
    line(`**Branch**: ${experiment.git_branch} @ ${experiment.git_commit || 'unknown'}`);
  }
  line('');

  // Experiment design
  line('## Experiment Design');
  line('');
  line(`- **Research question**: ${experiment.research_question}`);
  line(`- **Hypothesis**: ${experiment.hypothesis}`);
  line(`- **Independent variable**: ${experiment.independent_variable}`);
  line(`- **Primary metric**: ${experiment.primary_metric}`);
  if (experiment.description) {
    line(`- **Description**: ${experiment.description}`);
  }
  line('');

  // Cohort labels
  line('## Cohorts');
  line('');
  for (const cohortMeta of experiment.cohorts) {
    line(`- **${cohortMeta.label}**: ${cohortMeta.description || cohortMeta.source_type} (${cohortMeta.question_count} questions)`);
  }
  line('');

  // Executive summary
  line('## Executive Summary');
  line('');
  const headerCols = allMetrics.map(m => m.cohort);
  line(`| Cohort | Total | Gate Pass | Pass Rate | Diff Mismatch |`);
  line(`|--------|-------|-----------|-----------|---------------|`);
  for (const m of allMetrics) {
    line(`| ${m.cohort} | ${m.total} | ${m.gate_pass_count} | ${pct(m.gate_pass_rate)}% | ${pct(m.difficulty_mismatch_rate)}% |`);
  }
  line('');

  // Impact deltas (each treatment vs control)
  if (controlMetrics && treatmentMetrics.length > 0) {
    line('## Impact Deltas');
    line('');
    line('| Comparison | Gate Pass Rate | Diff Mismatch Rate |');
    line('|------------|----------------|-------------------|');
    for (const t of treatmentMetrics) {
      line(`| control to ${t.cohort} | ${deltaStr(controlMetrics.gate_pass_rate, t.gate_pass_rate)}pp | ${deltaStr(controlMetrics.difficulty_mismatch_rate, t.difficulty_mismatch_rate)}pp |`);
    }
    // Treatment-to-treatment deltas
    for (let i = 0; i < treatmentMetrics.length; i++) {
      for (let j = i + 1; j < treatmentMetrics.length; j++) {
        line(`| ${treatmentMetrics[i].cohort} to ${treatmentMetrics[j].cohort} | ${deltaStr(treatmentMetrics[i].gate_pass_rate, treatmentMetrics[j].gate_pass_rate)}pp | ${deltaStr(treatmentMetrics[i].difficulty_mismatch_rate, treatmentMetrics[j].difficulty_mismatch_rate)}pp |`);
      }
    }
    line('');
  }

  // Gate criteria failure rates
  line('## Gate Criteria Failure Rates');
  line('');
  line(`| Criterion | ${headerCols.join(' | ')} |`);
  line(`|-----------|${headerCols.map(() => '----------').join('|')}|`);
  for (const crit of GATE_CRITERIA) {
    const cells = allMetrics.map(m => `${failRate(m.gate_fail_breakdown[crit], m.total)}%`);
    line(`| ${crit} | ${cells.join(' | ')} |`);
  }
  line('');

  // Type distribution
  line('## Question Type Distribution');
  line('');
  const allTypes = [...new Set(allMetrics.flatMap(m => Object.keys(m.type_distribution)))].sort();
  line(`| Type | ${headerCols.join(' | ')} |`);
  line(`|------|${headerCols.map(() => '----------').join('|')}|`);
  for (const type of allTypes) {
    const cells = allMetrics.map(m => String(m.type_distribution[type] || 0));
    line(`| ${type} | ${cells.join(' | ')} |`);
  }
  line('');

  // Severity distribution
  line('## Severity Distribution');
  line('');
  line(`| Severity | ${headerCols.join(' | ')} |`);
  line(`|----------|${headerCols.map(() => '----------').join('|')}|`);
  for (const sev of ['critical', 'minor', 'suggestion']) {
    const cells = allMetrics.map(m => String(m.severity_distribution[sev] || 0));
    line(`| ${sev} | ${cells.join(' | ')} |`);
  }
  line('');

  // Content hash overlap
  if (overlaps.size > 0) {
    line('## Content Hash Overlap');
    line('');
    line('| Comparison | Overlap | % of Smaller Cohort |');
    line('|------------|---------|---------------------|');
    for (const [pair, count] of overlaps) {
      const [labelA, labelB] = pair.split('/');
      const mA = allMetrics.find(m => m.cohort === labelA);
      const mB = allMetrics.find(m => m.cohort === labelB);
      const smaller = Math.min(mA?.total || 0, mB?.total || 0);
      const pctOverlap = smaller > 0 ? ((count / smaller) * 100).toFixed(1) : '0.0';
      line(`| ${labelA} and ${labelB} | ${count} | ${pctOverlap}% |`);
    }
    line('');
  }

  // Stage 2 metrics (treatment cohorts only)
  const treatmentWithStage2 = allMetrics.filter(m => m.stage2_metrics && m.cohort !== 'control');
  if (treatmentWithStage2.length > 0) {
    line('## Stage 2 Quality Metrics (Generation Pipeline)');
    line('');
    const s2Labels = treatmentWithStage2.map(m => m.cohort);
    line(`| Metric | ${s2Labels.join(' | ')} |`);
    line(`|--------|${s2Labels.map(() => '----------').join('|')}|`);
    const metricKeys: (keyof Stage2Metrics)[] = [
      'validation_pass_rate', 'structural_rejected', 'validation_rejected',
      'type_drift', 'meta_filtered', 'difficulty_relabeled',
    ];
    for (const key of metricKeys) {
      const cells = treatmentWithStage2.map(m => {
        const val = m.stage2_metrics?.[key];
        if (val === undefined || val === null) return 'N/A';
        return key === 'validation_pass_rate' ? `${(val as number).toFixed(1)}%` : String(val);
      });
      line(`| ${key.replace(/_/g, ' ')} | ${cells.join(' | ')} |`);
    }
    line('');
  }

  line('---');
  line('*Generated by `scripts/compare-experiments.ts`*');

  return lines.join('\n');
}

// ── Conclusion generator ───────────────────────────────────────────────

function generateConclusion(
  experiment: ExperimentRecord,
  controlMetrics: CohortMetrics | undefined,
  treatmentMetrics: CohortMetrics[],
): string {
  if (!controlMetrics || treatmentMetrics.length === 0) {
    return 'Insufficient cohort data for conclusion.';
  }

  const metric = experiment.primary_metric;
  const parts: string[] = [];

  for (const t of treatmentMetrics) {
    let controlVal: number;
    let treatmentVal: number;

    if (metric === 'gate_pass_rate') {
      controlVal = controlMetrics.gate_pass_rate;
      treatmentVal = t.gate_pass_rate;
    } else if (metric === 'difficulty_mismatch_rate') {
      controlVal = controlMetrics.difficulty_mismatch_rate;
      treatmentVal = t.difficulty_mismatch_rate;
    } else {
      controlVal = controlMetrics.gate_pass_rate;
      treatmentVal = t.gate_pass_rate;
    }

    const deltaPp = ((treatmentVal - controlVal) * 100).toFixed(1);
    const direction = treatmentVal > controlVal ? 'increase' : treatmentVal < controlVal ? 'decrease' : 'no change';
    parts.push(`Cohort ${t.cohort}: ${metric} ${direction} of ${deltaPp}pp (${pct(controlVal)}% -> ${pct(treatmentVal)}%)`);
  }

  // Determine if hypothesis was supported (simple heuristic: any improvement on primary metric)
  const bestTreatment = treatmentMetrics.reduce((best, t) => {
    const getVal = (m: CohortMetrics) =>
      metric === 'difficulty_mismatch_rate' ? -m.difficulty_mismatch_rate : m.gate_pass_rate;
    return getVal(t) > getVal(best) ? t : best;
  });

  const controlPrimary = metric === 'difficulty_mismatch_rate'
    ? controlMetrics.difficulty_mismatch_rate
    : controlMetrics.gate_pass_rate;
  const bestPrimary = metric === 'difficulty_mismatch_rate'
    ? bestTreatment.difficulty_mismatch_rate
    : bestTreatment.gate_pass_rate;

  // For mismatch rate, lower is better; for pass rate, higher is better
  const improved = metric === 'difficulty_mismatch_rate'
    ? bestPrimary < controlPrimary
    : bestPrimary > controlPrimary;

  const verdict = improved ? 'supported' : 'refuted';

  return `Hypothesis "${experiment.hypothesis}" was ${verdict}. ${parts.join('. ')}.`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  const supabase = createScriptSupabase({ write: true });

  // 1. Fetch experiment record
  const { data: experiment, error: expError } = await supabase
    .from('experiments')
    .select('*')
    .eq('id', options.experimentId)
    .single();

  if (expError || !experiment) {
    console.error(`Error fetching experiment: ${expError?.message || 'Not found'}`);
    process.exit(1);
  }

  console.log(`\nExperiment: ${experiment.name}`);
  console.log(`  Research question: ${experiment.research_question}`);
  console.log(`  Hypothesis: ${experiment.hypothesis}`);
  console.log(`  Primary metric: ${experiment.primary_metric}`);
  console.log(`  Cohorts: ${experiment.cohorts.length}`);

  // 2. Fetch all experiment questions
  console.log('\nFetching experiment questions...');
  const allQuestions = await fetchAllPages<QuestionRow>(
    supabase,
    'experiment_questions',
    (q: any) => q.eq('experiment_id', options.experimentId),
  );

  // 3. Group by cohort
  const cohortMap = new Map<string, QuestionRow[]>();
  for (const q of allQuestions) {
    const existing = cohortMap.get(q.cohort) || [];
    existing.push(q);
    cohortMap.set(q.cohort, existing);
  }

  // Sort: control first, then alphabetical
  const cohortLabels = [...cohortMap.keys()].sort((a, b) => {
    if (a === 'control') return -1;
    if (b === 'control') return 1;
    return a.localeCompare(b);
  });

  for (const label of cohortLabels) {
    console.log(`  ${label}: ${cohortMap.get(label)!.length} questions`);
  }

  // 4. Compute metrics for each cohort
  console.log('\nComputing metrics...');
  const allMetrics: CohortMetrics[] = [];

  for (const label of cohortLabels) {
    const questions = cohortMap.get(label)!;
    const metrics = computeMetrics(label, questions);

    // Attach stage2 metrics from experiment cohorts JSONB
    const cohortMeta = experiment.cohorts.find((c: any) => c.label === label);
    if (cohortMeta?.stage2_metrics) {
      metrics.stage2_metrics = cohortMeta.stage2_metrics;
    } else if (cohortMeta?.batch_id) {
      // Try fetching from batch table
      const batchTable = label === 'control' ? 'batches' : 'experiment_batches';
      const batchIds = cohortMeta.batch_ids || [cohortMeta.batch_id];
      // Use first batch for stage2 metrics
      const batchMetrics = await fetchBatchMetrics(supabase, batchIds[0], batchTable);
      if (batchMetrics) metrics.stage2_metrics = batchMetrics;
    }

    allMetrics.push(metrics);
  }

  // 5. Compute pairwise overlaps
  const overlaps = computePairwiseOverlap(cohortMap);

  // 6. Console summary
  const controlMetrics = allMetrics.find(m => m.cohort === 'control');
  const treatmentMetrics = allMetrics.filter(m => m.cohort !== 'control');

  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON SUMMARY');
  console.log('='.repeat(60));

  for (const m of allMetrics) {
    console.log(`\n  ${m.cohort}:`);
    console.log(`    Total: ${m.total}`);
    console.log(`    Gate pass: ${m.gate_pass_count} (${pct(m.gate_pass_rate)}%)`);
    console.log(`    Difficulty mismatch: ${m.difficulty_mismatch_count} (${pct(m.difficulty_mismatch_rate)}%)`);
    if (controlMetrics && m.cohort !== 'control') {
      console.log(`    Delta from control: ${deltaStr(controlMetrics.gate_pass_rate, m.gate_pass_rate)}pp`);
    }
  }

  console.log(`\n  Content overlap:`);
  for (const [pair, count] of overlaps) {
    console.log(`    ${pair}: ${count} shared hashes`);
  }
  console.log('\n' + '='.repeat(60));

  // 7. Generate conclusion
  const conclusion = generateConclusion(experiment as ExperimentRecord, controlMetrics, treatmentMetrics);
  console.log(`\n  Conclusion: ${conclusion}`);

  // 8. Build results JSONB
  const results = {
    computed_at: new Date().toISOString(),
    cohort_metrics: Object.fromEntries(allMetrics.map(m => [m.cohort, m])),
    pairwise_overlaps: Object.fromEntries(overlaps),
  };

  // 9. Write results back to experiment
  const updatePayload: Record<string, unknown> = { results, conclusion };

  // 10. JSON export
  if (options.exportPath) {
    writeFileSync(options.exportPath, JSON.stringify(results, null, 2));
    console.log(`\nJSON export: ${options.exportPath}`);
  }

  // 11. Markdown report
  if (options.reportPath) {
    const report = generateMarkdownReport(experiment as ExperimentRecord, allMetrics, overlaps);
    writeFileSync(options.reportPath, report);
    console.log(`Markdown report: ${options.reportPath}`);
    updatePayload.report_path = options.reportPath;
  }

  // 12. Update experiment record
  const { error: updateError } = await supabase
    .from('experiments')
    .update(updatePayload)
    .eq('id', options.experimentId);

  if (updateError) {
    console.error(`\nWarning: Failed to update experiment record: ${updateError.message}`);
  } else {
    console.log('\nExperiment record updated with results and conclusion.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
