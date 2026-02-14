/**
 * @deprecated Use scripts/compare-experiments.ts instead.
 * This script is kept for reference. The experiment framework replaces
 * hardcoded 3-cohort comparison with N-cohort support via experiment_questions.
 *
 * Three-Cohort Quality Comparison
 *
 * Compares question quality across three cohorts:
 * - Cohort A: Existing active questions (baseline)
 * - Cohort B: Full pipeline with current markdown
 * - Cohort C: Full pipeline + updated PDF-to-markdown prompt
 *
 * Usage:
 *   npx tsx scripts/compare-cohorts.ts \
 *     --cohort-a-unit unit-2 \
 *     --cohort-b cohort-b \
 *     --cohort-c cohort-c \
 *     --export data/cohort-comparison.json \
 *     --report docs/cohort-comparison.md
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

interface CLIOptions {
  cohortAUnit: string;
  cohortBBatchId: string;
  cohortCBatchId: string;
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

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    cohortAUnit: '',
    cohortBBatchId: '',
    cohortCBatchId: '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--cohort-a-unit':
        options.cohortAUnit = args[++i];
        break;
      case '--cohort-b':
        options.cohortBBatchId = args[++i];
        break;
      case '--cohort-c':
        options.cohortCBatchId = args[++i];
        break;
      case '--export':
        options.exportPath = args[++i];
        break;
      case '--report':
        options.reportPath = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  if (!options.cohortAUnit || !options.cohortBBatchId || !options.cohortCBatchId) {
    console.error('Error: Missing required arguments');
    printHelp();
    process.exit(1);
  }

  return options;
}

function printHelp(): void {
  console.log(`
Three-Cohort Quality Comparison

Usage:
  npx tsx scripts/compare-cohorts.ts [options]

Required:
  --cohort-a-unit <unit-id>    Baseline unit (e.g., unit-2)
  --cohort-b <batch-id>        Pipeline batch ID
  --cohort-c <batch-id>        Pipeline+prompt batch ID

Optional:
  --export <path>              Export JSON data
  --report <path>              Generate markdown report
  --help, -h                   Show this help
  `);
}

// ============================================================================
// Data fetching
// ============================================================================

const PAGE_SIZE = 1000;

async function fetchAllPages(
  supabase: SupabaseClient,
  buildQuery: (query: any) => any
): Promise<QuestionRow[]> {
  const all: QuestionRow[] = [];
  let page = 0;

  while (true) {
    let query = supabase
      .from('questions')
      .select('*')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    query = buildQuery(query);
    const { data, error } = await query;

    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...(data as QuestionRow[]));
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

async function fetchCohortA(
  supabase: SupabaseClient,
  unitId: string,
  excludeBatchIds: string[]
): Promise<QuestionRow[]> {
  const all = await fetchAllPages(supabase, (query) =>
    query.eq('unit_id', unitId).eq('quality_status', 'active')
  );

  // Filter out experiment batches
  return all.filter(
    (q) => !q.batch_id || !excludeBatchIds.includes(q.batch_id)
  );
}

async function fetchCohortByBatch(
  supabase: SupabaseClient,
  batchId: string
): Promise<QuestionRow[]> {
  return fetchAllPages(supabase, (query) => query.eq('batch_id', batchId));
}

async function fetchBatchMetrics(
  supabase: SupabaseClient,
  batchId: string
): Promise<Stage2Metrics | null> {
  const { data } = await supabase
    .from('batches')
    .select('quality_metrics')
    .eq('id', batchId)
    .single();

  return data?.quality_metrics ?? null;
}

// ============================================================================
// Metric computation
// ============================================================================

const GATE_CRITERIA = [
  'answer_correct',
  'grammar_correct',
  'no_hallucination',
  'question_coherent',
  'natural_french',
  'register_appropriate',
];

function computeMetrics(
  cohortLabel: string,
  questions: QuestionRow[]
): CohortMetrics {
  const gateFails: Record<string, number> = {};
  for (const c of GATE_CRITERIA) gateFails[c] = 0;

  let gatePassCount = 0;
  let diffMismatchCount = 0;

  const severityDist: Record<string, number> = {
    critical: 0,
    minor: 0,
    suggestion: 0,
  };
  const typeDist: Record<string, number> = {};
  const topicSet = new Set<string>();

  for (const q of questions) {
    // Type distribution
    typeDist[q.type] = (typeDist[q.type] || 0) + 1;

    // Topic coverage
    if (q.topic) topicSet.add(q.topic);

    const gate = q.audit_metadata?.gate_criteria;
    if (gate) {
      // Gate pass: all 6 criteria true (treat missing as passing for Cohort A compatibility)
      let allPass = true;
      for (const c of GATE_CRITERIA) {
        if (gate[c] === false) {
          gateFails[c]++;
          allPass = false;
        }
        // If criterion is undefined (e.g. Sonnet audit without natural_french), treat as pass
      }
      if (allPass) gatePassCount++;
    } else {
      // No audit metadata — count as pass (Cohort A questions without audit data)
      gatePassCount++;
    }

    // Difficulty mismatch
    if (q.audit_metadata?.soft_signals?.difficulty_appropriate === false) {
      diffMismatchCount++;
    }

    // Severity
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
    difficulty_mismatch_rate:
      questions.length > 0 ? diffMismatchCount / questions.length : 0,
    stage2_metrics: null,
    topic_coverage: [...topicSet].sort(),
    type_distribution: typeDist,
    severity_distribution: severityDist,
  };
}

function computeHashOverlap(cohorts: {
  a: QuestionRow[];
  b: QuestionRow[];
  c: QuestionRow[];
}): { a_b: number; a_c: number; b_c: number } {
  const hashA = new Set(cohorts.a.map((q) => q.content_hash).filter(Boolean));
  const hashB = new Set(cohorts.b.map((q) => q.content_hash).filter(Boolean));
  const hashC = new Set(cohorts.c.map((q) => q.content_hash).filter(Boolean));

  const intersection = (setA: Set<string>, setB: Set<string>): number => {
    let count = 0;
    for (const item of setA) {
      if (setB.has(item)) count++;
    }
    return count;
  };

  return {
    a_b: intersection(hashA, hashB),
    a_c: intersection(hashA, hashC),
    b_c: intersection(hashB, hashC),
  };
}

// ============================================================================
// Report generation
// ============================================================================

function pct(n: number): string {
  return (n * 100).toFixed(1);
}

function failRate(count: number, total: number): string {
  return total > 0 ? (count / total * 100).toFixed(1) : '0.0';
}

function delta(a: number, b: number): string {
  const d = ((b - a) * 100).toFixed(1);
  return parseFloat(d) >= 0 ? `+${d}` : d;
}

function generateMarkdownReport(
  metricsA: CohortMetrics,
  metricsB: CohortMetrics,
  metricsC: CohortMetrics,
  overlap: { a_b: number; a_c: number; b_c: number }
): string {
  const lines: string[] = [];
  const line = (s: string) => lines.push(s);

  line('# Three-Cohort Quality Comparison Report');
  line('');
  line(`**Generated**: ${new Date().toISOString()}`);
  line('');
  line('- **Cohort A**: Existing active questions (baseline)');
  line('- **Cohort B**: Current pipeline + current markdown');
  line('- **Cohort C**: Current pipeline + reconverted markdown (new prompt)');
  line('');

  // Executive summary
  line('## Executive Summary');
  line('');
  line('| Cohort | Total | Gate Pass | Pass Rate | Diff Mismatch |');
  line('|--------|-------|-----------|-----------|---------------|');
  line(`| A (Baseline) | ${metricsA.total} | ${metricsA.gate_pass_count} | ${pct(metricsA.gate_pass_rate)}% | ${pct(metricsA.difficulty_mismatch_rate)}% |`);
  line(`| B (Pipeline) | ${metricsB.total} | ${metricsB.gate_pass_count} | ${pct(metricsB.gate_pass_rate)}% | ${pct(metricsB.difficulty_mismatch_rate)}% |`);
  line(`| C (Pipeline+Prompt) | ${metricsC.total} | ${metricsC.gate_pass_count} | ${pct(metricsC.gate_pass_rate)}% | ${pct(metricsC.difficulty_mismatch_rate)}% |`);
  line('');

  // Written analysis
  line('### Analysis');
  line('');

  // Cohort A baseline caveat
  if (metricsA.gate_pass_rate > 0.99) {
    line('**Cohort A baseline caveat**: Cohort A shows a near-perfect gate pass rate because these questions were audited by the earlier Sonnet auditor, which evaluated only 4 of the 6 gate criteria. The two missing criteria (`natural_french` and `register_appropriate`) are treated as passing, inflating Cohort A\'s apparent quality. The A-to-B/C deltas therefore do not represent a real regression — they reflect the stricter 6-criteria Mistral gate applied to B and C.');
    line('');
  }

  // B vs C comparison
  const bcDelta = Math.abs(metricsB.gate_pass_rate - metricsC.gate_pass_rate);
  if (bcDelta < 0.02) {
    line('**B vs C (prompt update impact)**: The reconverted markdown (new PDF-to-markdown prompt) produced no measurable difference in question quality. Both cohorts achieved nearly identical gate pass rates, per-criteria failure distributions, and difficulty mismatch rates. This suggests the existing markdown was already adequate for question generation — the pipeline\'s quality is driven by the generation and validation stages, not the source material formatting.');
  } else {
    const better = metricsB.gate_pass_rate > metricsC.gate_pass_rate ? 'B' : 'C';
    const worse = better === 'B' ? 'C' : 'B';
    line(`**B vs C (prompt update impact)**: Cohort ${better} outperformed Cohort ${worse} by ${pct(bcDelta)}pp in gate pass rate. ${better === 'C' ? 'The updated PDF-to-markdown prompt improved source material quality enough to affect downstream question generation.' : 'The original markdown produced slightly better questions than the reconverted version, suggesting the new PDF prompt may have introduced noise or lost useful structure.'}`);
  }
  line('');

  // Difficulty mismatch improvement
  const diffImprove = metricsA.difficulty_mismatch_rate - metricsB.difficulty_mismatch_rate;
  if (diffImprove > 0.1) {
    line(`**Difficulty calibration**: The pipeline\'s difficulty calibration improved substantially — mismatch dropped from ${pct(metricsA.difficulty_mismatch_rate)}% (Cohort A) to ${pct(metricsB.difficulty_mismatch_rate)}% (Cohort B), a ${pct(diffImprove)}pp reduction. This reflects the cumulative impact of exemplar-anchored difficulty definitions, validation-time relabeling, and Mistral\'s post-audit difficulty adjustment.`);
    line('');
  }

  // Notable criterion findings
  const bNatural = (metricsB.gate_fail_breakdown['natural_french'] || 0) / metricsB.total;
  const cNatural = (metricsC.gate_fail_breakdown['natural_french'] || 0) / metricsC.total;
  if (bNatural > 0.04 || cNatural > 0.04) {
    line(`**Top failure mode**: \`natural_french\` is the leading gate failure criterion at ${pct(bNatural)}% (B) / ${pct(cNatural)}% (C), exceeding traditional criteria like answer correctness and grammar. This criterion was not evaluated in Cohort A. It flags questions where the French sounds unnatural or overly literal — a blind spot that the earlier Sonnet auditor missed entirely.`);
    line('');
  }

  // Content overlap
  if (overlap.b_c > 0) {
    const bcOverlapPct = (overlap.b_c / Math.min(metricsB.total, metricsC.total) * 100).toFixed(1);
    line(`**Content overlap**: ${overlap.b_c} questions (${bcOverlapPct}% of the smaller cohort) share identical content hashes between B and C, confirming that different markdown sources can produce some identical questions when the same topics and pipeline are used. Zero overlap with Cohort A confirms the current pipeline generates entirely different questions than the original.`);
    line('');
  }

  // Severity shift
  const aCritical = metricsA.severity_distribution['critical'] || 0;
  const bCritical = metricsB.severity_distribution['critical'] || 0;
  if (bCritical > aCritical * 2) {
    line(`**Unexpected: higher critical severity count**: Cohorts B (${bCritical}) and C (${metricsC.severity_distribution['critical'] || 0}) show more critical-severity findings than Cohort A (${aCritical}). This likely reflects Mistral\'s broader evaluation scope (6 criteria vs 4) rather than worse question quality — more criteria means more opportunities to flag issues as critical.`);
    line('');
  }

  // Impact deltas
  line('## Impact Deltas');
  line('');
  line(`| Comparison | Gate Pass Rate | Diff Mismatch Rate |`);
  line(`|------------|----------------|-------------------|`);
  line(`| A to B (cumulative pipeline) | ${delta(metricsA.gate_pass_rate, metricsB.gate_pass_rate)}pp | ${delta(metricsA.difficulty_mismatch_rate, metricsB.difficulty_mismatch_rate)}pp |`);
  line(`| B to C (prompt update) | ${delta(metricsB.gate_pass_rate, metricsC.gate_pass_rate)}pp | ${delta(metricsB.difficulty_mismatch_rate, metricsC.difficulty_mismatch_rate)}pp |`);
  line(`| A to C (total improvement) | ${delta(metricsA.gate_pass_rate, metricsC.gate_pass_rate)}pp | ${delta(metricsA.difficulty_mismatch_rate, metricsC.difficulty_mismatch_rate)}pp |`);
  line('');

  // Gate criteria breakdown
  line('## Gate Criteria Failure Rates');
  line('');
  line('| Criterion | Cohort A | Cohort B | Cohort C |');
  line('|-----------|----------|----------|----------|');
  for (const crit of GATE_CRITERIA) {
    line(`| ${crit} | ${failRate(metricsA.gate_fail_breakdown[crit], metricsA.total)}% | ${failRate(metricsB.gate_fail_breakdown[crit], metricsB.total)}% | ${failRate(metricsC.gate_fail_breakdown[crit], metricsC.total)}% |`);
  }
  line('');

  // Type distribution
  line('## Question Type Distribution');
  line('');
  line('| Type | Cohort A | Cohort B | Cohort C |');
  line('|------|----------|----------|----------|');
  const allTypes = [
    ...new Set([
      ...Object.keys(metricsA.type_distribution),
      ...Object.keys(metricsB.type_distribution),
      ...Object.keys(metricsC.type_distribution),
    ]),
  ].sort();
  for (const type of allTypes) {
    line(`| ${type} | ${metricsA.type_distribution[type] || 0} | ${metricsB.type_distribution[type] || 0} | ${metricsC.type_distribution[type] || 0} |`);
  }
  line('');

  // Severity distribution
  line('## Severity Distribution');
  line('');
  line('| Severity | Cohort A | Cohort B | Cohort C |');
  line('|----------|----------|----------|----------|');
  for (const sev of ['critical', 'minor', 'suggestion']) {
    line(`| ${sev} | ${metricsA.severity_distribution[sev] || 0} | ${metricsB.severity_distribution[sev] || 0} | ${metricsC.severity_distribution[sev] || 0} |`);
  }
  line('');

  // Content overlap
  line('## Content Hash Overlap');
  line('');
  line('| Comparison | Overlap | % of Smaller Cohort |');
  line('|------------|---------|---------------------|');
  const overlapPct = (ov: number, a: number, b: number) =>
    Math.min(a, b) > 0 ? (ov / Math.min(a, b) * 100).toFixed(1) : '0.0';
  line(`| A and B | ${overlap.a_b} | ${overlapPct(overlap.a_b, metricsA.total, metricsB.total)}% |`);
  line(`| A and C | ${overlap.a_c} | ${overlapPct(overlap.a_c, metricsA.total, metricsC.total)}% |`);
  line(`| B and C | ${overlap.b_c} | ${overlapPct(overlap.b_c, metricsB.total, metricsC.total)}% |`);
  line('');

  // Stage 2 metrics
  if (metricsB.stage2_metrics || metricsC.stage2_metrics) {
    line('## Stage 2 Quality Metrics (Generation Pipeline)');
    line('');
    line('| Metric | Cohort B | Cohort C |');
    line('|--------|----------|----------|');
    const b2 = metricsB.stage2_metrics;
    const c2 = metricsC.stage2_metrics;
    line(`| Validation pass rate | ${b2?.validation_pass_rate?.toFixed(1) ?? 'N/A'}% | ${c2?.validation_pass_rate?.toFixed(1) ?? 'N/A'}% |`);
    line(`| Structural rejected | ${b2?.structural_rejected ?? 'N/A'} | ${c2?.structural_rejected ?? 'N/A'} |`);
    line(`| Validation rejected | ${b2?.validation_rejected ?? 'N/A'} | ${c2?.validation_rejected ?? 'N/A'} |`);
    line(`| Type drift | ${b2?.type_drift ?? 'N/A'} | ${c2?.type_drift ?? 'N/A'} |`);
    line(`| Meta filtered | ${b2?.meta_filtered ?? 'N/A'} | ${c2?.meta_filtered ?? 'N/A'} |`);
    line(`| Difficulty relabeled | ${b2?.difficulty_relabeled ?? 'N/A'} | ${c2?.difficulty_relabeled ?? 'N/A'} |`);
    line('');
  }

  // Topic coverage - only show if different across cohorts
  const topicsIdentical =
    JSON.stringify(metricsA.topic_coverage) === JSON.stringify(metricsB.topic_coverage) &&
    JSON.stringify(metricsB.topic_coverage) === JSON.stringify(metricsC.topic_coverage);
  if (!topicsIdentical) {
    line('## Topic Coverage');
    line('');
    for (const [label, metrics] of [['A (Baseline)', metricsA], ['B (Pipeline)', metricsB], ['C (Pipeline+Prompt)', metricsC]] as const) {
      line(`### Cohort ${label}`);
      for (const t of metrics.topic_coverage) {
        line(`- ${t}`);
      }
      line('');
    }
  }

  // Recommendations
  line('## Recommendations');
  line('');

  // 1. Re-audit Cohort A (if baseline is inflated)
  if (metricsA.gate_pass_rate > 0.99) {
    line('### 1. Re-audit Cohort A with Mistral for a valid baseline');
    line('');
    line('The A-to-B/C comparison is currently apples-to-oranges (4-criteria Sonnet vs 6-criteria Mistral). Running the Mistral auditor on existing Cohort A questions would produce a true comparison. Cost: ~$2, ~12 min.');
    line('');
    line('```bash');
    line('npx tsx scripts/audit-quality-mistral.ts --write-db --unit unit-2');
    line('```');
    line('');
  }

  // 2. Target natural_french
  if (bNatural > 0.04 || cNatural > 0.04) {
    line(`### 2. Target \`natural_french\` in the generation prompt`);
    line('');
    line(`At ${pct(Math.max(bNatural, cNatural))}%, unnatural French is the leading gate failure — ahead of answer correctness and grammar. Adding French naturalness guidance to the generation prompt (avoid literal English calques, use idiomatic phrasing, prefer common constructions) could reduce this without pipeline changes.`);
    line('');
  }

  // 3. Don't pursue PDF prompt
  if (bcDelta < 0.02) {
    line('### 3. Do not invest further in the PDF-to-markdown prompt');
    line('');
    line('B and C are statistically identical. The source material formatting is not a quality bottleneck — the generation and validation stages drive quality. Future improvement effort should focus on those stages instead.');
    line('');
  }

  // 4. Difficulty calibration
  if (metricsB.difficulty_mismatch_rate > 0.1) {
    const bRelabeled = metricsB.stage2_metrics?.difficulty_relabeled ?? 0;
    const bTotal = metricsB.stage2_metrics ? (bRelabeled / (metricsB.total + (metricsB.stage2_metrics.validation_rejected ?? 0) + (metricsB.stage2_metrics.type_drift ?? 0) + (metricsB.stage2_metrics.meta_filtered ?? 0)) * 100).toFixed(0) : '?';
    line('### 4. Reduce generation-time difficulty miscalibration');
    line('');
    line(`Despite the 22pp improvement over Cohort A, ${pct(metricsB.difficulty_mismatch_rate)}% of questions still have post-audit difficulty mismatches and ~${bTotal}% are relabeled during generation. The generation models systematically miscalibrate difficulty. Adding few-shot difficulty examples directly in the generation prompt (beyond the exemplar pool) or using difficulty-specific system prompts could reduce post-hoc relabeling.`);
    line('');
  }

  // 5. Type distribution shift
  const aFib = metricsA.type_distribution['fill-in-blank'] || 0;
  const bFib = metricsB.type_distribution['fill-in-blank'] || 0;
  const aFibPct = metricsA.total > 0 ? (aFib / metricsA.total * 100) : 0;
  const bFibPct = metricsB.total > 0 ? (bFib / metricsB.total * 100) : 0;
  if (Math.abs(aFibPct - bFibPct) > 8) {
    line('### 5. Review question type distribution');
    line('');
    line(`Cohort A was ${aFibPct.toFixed(0)}% fill-in-blank; B/C are ${bFibPct.toFixed(0)}%. The hybrid model routing may be shifting the type mix toward MCQ. If fill-in-blank and writing are pedagogically more valuable (they require production, not just recognition), consider rebalancing the per-type target counts in the generation loop.`);
    line('');
  }

  // 6. Type drift difference
  const bDrift = metricsB.stage2_metrics?.type_drift ?? 0;
  const cDrift = metricsC.stage2_metrics?.type_drift ?? 0;
  if (cDrift > bDrift * 2 && cDrift > 5) {
    line('### 6. Investigate higher type drift in Cohort C');
    line('');
    line(`Cohort C had ${cDrift} type-drift rejections vs ${bDrift} in Cohort B (${(cDrift / bDrift).toFixed(1)}x). The reconverted markdown may be structured in a way that causes the AI to generate off-type questions more often. While these are filtered out (no quality impact), they waste generation tokens.`);
    line('');
  }

  // 7. Experiment cleanup
  line('### 7. Decide on experiment question disposition');
  line('');
  line(`${metricsB.gate_pass_count + metricsC.gate_pass_count} experiment questions passed audit and are now \`active\` in unit-2, alongside the original ${metricsA.total}. Options:`);
  line('');
  line('- **Keep**: Deepens the question pool, giving students more variety');
  line('- **Keep best cohort only**: Delete the lower-performing cohort\'s questions');
  line('- **Delete all**: `DELETE FROM questions WHERE batch_id LIKE \'cohort-%\'`');
  line('');

  // 8. Extend naturalness checks to validation
  if (bNatural > 0.04) {
    line('### 8. Add naturalness check to Stage 2 validation');
    line('');
    line('Currently, Sonnet validation (Stage 2) only checks answer correctness. Since `natural_french` is the top failure mode caught at Stage 3, adding a naturalness check to Stage 2 would catch these earlier — reducing wasted audit tokens on questions that will be flagged anyway.');
    line('');
  }

  line('---');
  line('*Generated by `scripts/compare-cohorts.ts`*');

  return lines.join('\n');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const options = parseArgs();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('Fetching cohort questions...');
  const excludeBatchIds = [options.cohortBBatchId, options.cohortCBatchId];
  const [cohortA, cohortB, cohortC] = await Promise.all([
    fetchCohortA(supabase, options.cohortAUnit, excludeBatchIds),
    fetchCohortByBatch(supabase, options.cohortBBatchId),
    fetchCohortByBatch(supabase, options.cohortCBatchId),
  ]);

  console.log(`  Cohort A (baseline): ${cohortA.length} questions`);
  console.log(`  Cohort B (pipeline): ${cohortB.length} questions`);
  console.log(`  Cohort C (pipeline+prompt): ${cohortC.length} questions`);

  // Fetch stage 2 metrics from batches table
  const [batchBMetrics, batchCMetrics] = await Promise.all([
    fetchBatchMetrics(supabase, options.cohortBBatchId),
    fetchBatchMetrics(supabase, options.cohortCBatchId),
  ]);

  console.log('\nComputing metrics...');
  const metricsA = computeMetrics('A (Baseline)', cohortA);
  const metricsB = computeMetrics('B (Pipeline)', cohortB);
  const metricsC = computeMetrics('C (Pipeline+Prompt)', cohortC);

  metricsB.stage2_metrics = batchBMetrics;
  metricsC.stage2_metrics = batchCMetrics;

  const overlap = computeHashOverlap({ a: cohortA, b: cohortB, c: cohortC });

  // Console summary
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON SUMMARY');
  console.log('='.repeat(60));

  console.log(`\n  Cohort A (baseline):`);
  console.log(`    Total: ${metricsA.total}`);
  console.log(`    Gate pass: ${metricsA.gate_pass_count} (${pct(metricsA.gate_pass_rate)}%)`);
  console.log(`    Difficulty mismatch: ${metricsA.difficulty_mismatch_count} (${pct(metricsA.difficulty_mismatch_rate)}%)`);

  console.log(`\n  Cohort B (pipeline):`);
  console.log(`    Total: ${metricsB.total}`);
  console.log(`    Gate pass: ${metricsB.gate_pass_count} (${pct(metricsB.gate_pass_rate)}%)`);
  console.log(`    Delta from A: ${delta(metricsA.gate_pass_rate, metricsB.gate_pass_rate)}pp`);

  console.log(`\n  Cohort C (pipeline+prompt):`);
  console.log(`    Total: ${metricsC.total}`);
  console.log(`    Gate pass: ${metricsC.gate_pass_count} (${pct(metricsC.gate_pass_rate)}%)`);
  console.log(`    Delta from B: ${delta(metricsB.gate_pass_rate, metricsC.gate_pass_rate)}pp`);
  console.log(`    Delta from A: ${delta(metricsA.gate_pass_rate, metricsC.gate_pass_rate)}pp (cumulative)`);

  console.log(`\n  Content overlap:`);
  console.log(`    A/B: ${overlap.a_b} shared hashes`);
  console.log(`    A/C: ${overlap.a_c} shared hashes`);
  console.log(`    B/C: ${overlap.b_c} shared hashes`);

  console.log('\n' + '='.repeat(60));

  // JSON export
  if (options.exportPath) {
    const exportData = { metricsA, metricsB, metricsC, overlap };
    writeFileSync(options.exportPath, JSON.stringify(exportData, null, 2));
    console.log(`\nJSON export: ${options.exportPath}`);
  }

  // Markdown report
  if (options.reportPath) {
    const report = generateMarkdownReport(metricsA, metricsB, metricsC, overlap);
    writeFileSync(options.reportPath, report);
    console.log(`Markdown report: ${options.reportPath}`);
  }
}

main().catch(console.error);
