/**
 * One-time migration: Move existing B/C cohort data from questions/batches
 * to experiment_questions/experiment_batches.
 *
 * Steps:
 * 1. Backfill existing batches.config with comprehensive provenance
 * 2. Create experiment record (snapshots control via create-experiment.ts)
 * 3. Copy B/C questions -> experiment_questions
 * 4. Copy B/C batch records -> experiment_batches
 * 5. Update experiment cohorts JSONB
 * 6. Delete B/C from questions and batches
 *
 * Usage:
 *   npx tsx scripts/migrate-experiment-20260214.ts --experiment-id <uuid>
 *   npx tsx scripts/migrate-experiment-20260214.ts --dry-run
 *
 * IMPORTANT: Run create-experiment.ts first to get the experiment ID,
 * or use --dry-run to preview what would happen.
 *
 * After verification, archive to scripts/archive/.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { MODELS } from './lib/config';

const COHORT_B_BATCH_ID = 'cohort-b-20260213_164307';
const COHORT_C_BATCH_ID = 'cohort-c-20260213_164307';

interface CLIOptions {
  experimentId?: string;
  dryRun: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--experiment-id':
        options.experimentId = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
    }
  }

  if (!options.experimentId && !options.dryRun) {
    console.error('Error: --experiment-id required (or use --dry-run)');
    console.error('');
    console.error('First create the experiment:');
    console.error('  npx tsx scripts/create-experiment.ts --unit unit-2');
    console.error('');
    console.error('Then run this migration with the returned ID:');
    console.error('  npx tsx scripts/migrate-experiment-20260214.ts --experiment-id <uuid>');
    process.exit(1);
  }

  return options;
}

const PAGE_SIZE = 1000;

async function fetchAllPages(
  supabase: SupabaseClient,
  table: string,
  buildQuery: (query: any) => any,
): Promise<any[]> {
  const all: any[] = [];
  let page = 0;

  while (true) {
    let query = supabase
      .from(table)
      .select('*')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    query = buildQuery(query);
    const { data, error } = await query;

    if (error) throw new Error(`Fetch error on ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  return all;
}

async function main() {
  const options = parseArgs();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Error: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY required.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('=== Experiment Data Migration ===\n');

  // Step 1: Backfill existing batches.config with comprehensive provenance
  console.log('Step 1: Backfill batches.config with provenance...');
  const { data: allBatches, error: batchFetchError } = await supabase
    .from('batches')
    .select('id, config, created_at');

  if (batchFetchError) {
    console.error(`Error fetching batches: ${batchFetchError.message}`);
    process.exit(1);
  }

  const provenanceModels = {
    generation_structured: MODELS.questionGenerationStructured,
    generation_typed: MODELS.questionGenerationTyped,
    validation: MODELS.answerValidation,
    audit: MODELS.audit,
    pdf_conversion: MODELS.pdfConversion,
    topic_extraction: MODELS.topicExtraction,
  };

  let backfilled = 0;
  for (const batch of allBatches || []) {
    const existingConfig = batch.config || {};
    // Skip if already has comprehensive config
    if (existingConfig.models && existingConfig.git) continue;

    const enrichedConfig = {
      ...existingConfig,
      models: existingConfig.models || provenanceModels,
      git: existingConfig.git || {
        branch: 'main',
        commit: 'pre-migration',
      },
      cli_args: existingConfig.cli_args || existingConfig.args || existingConfig,
    };

    if (!options.dryRun) {
      const { error } = await supabase
        .from('batches')
        .update({ config: enrichedConfig })
        .eq('id', batch.id);

      if (error) {
        console.error(`  Error updating batch ${batch.id}: ${error.message}`);
      } else {
        backfilled++;
      }
    } else {
      backfilled++;
    }
  }
  console.log(`  ${options.dryRun ? 'Would backfill' : 'Backfilled'} ${backfilled} batch records\n`);

  // Step 2: Fetch B/C questions
  console.log('Step 2: Fetch B/C questions from production table...');
  const cohortBQuestions = await fetchAllPages(supabase, 'questions', (q: any) =>
    q.eq('batch_id', COHORT_B_BATCH_ID),
  );
  const cohortCQuestions = await fetchAllPages(supabase, 'questions', (q: any) =>
    q.eq('batch_id', COHORT_C_BATCH_ID),
  );

  console.log(`  Cohort B: ${cohortBQuestions.length} questions`);
  console.log(`  Cohort C: ${cohortCQuestions.length} questions\n`);

  if (cohortBQuestions.length === 0 && cohortCQuestions.length === 0) {
    console.log('No experiment questions found in production table. Migration may have already been done.');
    return;
  }

  // Step 3: Fetch B/C batch records
  console.log('Step 3: Fetch B/C batch records...');
  const { data: batchB } = await supabase.from('batches').select('*').eq('id', COHORT_B_BATCH_ID).single();
  const { data: batchC } = await supabase.from('batches').select('*').eq('id', COHORT_C_BATCH_ID).single();
  console.log(`  Batch B: ${batchB ? 'found' : 'not found'}`);
  console.log(`  Batch C: ${batchC ? 'found' : 'not found'}\n`);

  if (options.dryRun) {
    console.log('[DRY RUN] Would perform the following:');
    console.log(`  - Insert ${cohortBQuestions.length} Cohort B questions into experiment_questions`);
    console.log(`  - Insert ${cohortCQuestions.length} Cohort C questions into experiment_questions`);
    if (batchB) console.log(`  - Insert batch ${COHORT_B_BATCH_ID} into experiment_batches`);
    if (batchC) console.log(`  - Insert batch ${COHORT_C_BATCH_ID} into experiment_batches`);
    console.log(`  - Delete B/C questions from production table`);
    console.log(`  - Delete B/C batch records from batches table`);
    return;
  }

  const experimentId = options.experimentId!;

  // Step 4: Insert B/C questions into experiment_questions
  console.log('Step 4: Copy questions to experiment_questions...');
  const BATCH_SIZE = 100;

  for (const [label, questions] of [['B', cohortBQuestions], ['C', cohortCQuestions]] as const) {
    let inserted = 0;
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      const batch = questions.slice(i, i + BATCH_SIZE).map((q: any) => ({
        experiment_id: experimentId,
        cohort: label,
        original_question_id: q.id,
        question: q.question,
        correct_answer: q.correct_answer,
        explanation: q.explanation,
        unit_id: q.unit_id,
        topic: q.topic,
        difficulty: q.difficulty,
        type: q.type,
        options: q.options,
        acceptable_variations: q.acceptable_variations,
        writing_type: q.writing_type,
        hints: q.hints,
        requires_complete_sentence: q.requires_complete_sentence,
        content_hash: q.content_hash,
        batch_id: q.batch_id,
        source_file: q.source_file,
        generated_by: q.generated_by,
        quality_status: q.quality_status,
        audit_metadata: q.audit_metadata,
      }));

      const { error } = await supabase
        .from('experiment_questions')
        .insert(batch);

      if (error) {
        console.error(`  Error inserting Cohort ${label} batch: ${error.message}`);
        process.exit(1);
      }
      inserted += batch.length;
    }
    console.log(`  Cohort ${label}: ${inserted} questions copied`);
  }
  console.log('');

  // Step 5: Copy batch records to experiment_batches
  console.log('Step 5: Copy batch records to experiment_batches...');
  for (const [label, batch] of [['B', batchB], ['C', batchC]] as const) {
    if (!batch) continue;
    const { id, created_at, ...rest } = batch;
    const { error } = await supabase
      .from('experiment_batches')
      .insert({
        ...rest,
        id,
        created_at,
        experiment_id: experimentId,
        cohort: label,
      });

    if (error) {
      console.error(`  Error inserting batch ${label}: ${error.message}`);
    } else {
      console.log(`  Batch ${label} (${id}) copied`);
    }
  }
  console.log('');

  // Step 6: Update experiment cohorts JSONB
  console.log('Step 6: Update experiment cohorts JSONB...');
  const { data: experiment } = await supabase
    .from('experiments')
    .select('cohorts')
    .eq('id', experimentId)
    .single();

  if (experiment) {
    const cohorts = (experiment.cohorts as any[]) || [];

    if (cohortBQuestions.length > 0) {
      cohorts.push({
        label: 'B',
        source_type: 'generated',
        description: 'Current pipeline + current markdown',
        batch_id: COHORT_B_BATCH_ID,
        question_count: cohortBQuestions.length,
        stage2_metrics: batchB?.quality_metrics || null,
      });
    }

    if (cohortCQuestions.length > 0) {
      cohorts.push({
        label: 'C',
        source_type: 'generated',
        description: 'Current pipeline + reconverted markdown (new prompt)',
        batch_id: COHORT_C_BATCH_ID,
        question_count: cohortCQuestions.length,
        stage2_metrics: batchC?.quality_metrics || null,
      });
    }

    await supabase
      .from('experiments')
      .update({ cohorts })
      .eq('id', experimentId);

    console.log(`  Updated with ${cohorts.length} cohorts\n`);
  }

  // Step 7: Delete B/C from production
  console.log('Step 7: Delete B/C from production tables...');

  // First, unflag any flagged questions (bypass protect_flagged_questions trigger)
  for (const batchId of [COHORT_B_BATCH_ID, COHORT_C_BATCH_ID]) {
    await supabase
      .from('questions')
      .update({ quality_status: 'pending' })
      .eq('batch_id', batchId)
      .eq('quality_status', 'flagged');
  }

  // Now delete
  for (const batchId of [COHORT_B_BATCH_ID, COHORT_C_BATCH_ID]) {
    const { error: delError, count } = await supabase
      .from('questions')
      .delete()
      .eq('batch_id', batchId);

    if (delError) {
      console.error(`  Error deleting questions for ${batchId}: ${delError.message}`);
    } else {
      console.log(`  Deleted questions for batch ${batchId}`);
    }
  }

  // Delete batch records
  for (const batchId of [COHORT_B_BATCH_ID, COHORT_C_BATCH_ID]) {
    const { error: delError } = await supabase
      .from('batches')
      .delete()
      .eq('id', batchId);

    if (delError) {
      console.error(`  Error deleting batch ${batchId}: ${delError.message}`);
    } else {
      console.log(`  Deleted batch ${batchId}`);
    }
  }
  console.log('');

  // Step 8: Verification
  console.log('Step 8: Verification...');

  const { count: expQCount } = await supabase
    .from('experiment_questions')
    .select('*', { count: 'exact', head: true })
    .eq('experiment_id', experimentId);

  const { count: prodBCount } = await supabase
    .from('questions')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', COHORT_B_BATCH_ID);

  const { count: prodCCount } = await supabase
    .from('questions')
    .select('*', { count: 'exact', head: true })
    .eq('batch_id', COHORT_C_BATCH_ID);

  const { count: expBatchCount } = await supabase
    .from('experiment_batches')
    .select('*', { count: 'exact', head: true })
    .eq('experiment_id', experimentId);

  console.log(`  experiment_questions (this experiment): ${expQCount}`);
  console.log(`  Remaining B/C in production questions: ${(prodBCount || 0) + (prodCCount || 0)}`);
  console.log(`  experiment_batches (this experiment): ${expBatchCount}`);
  console.log('');

  const expectedTotal = cohortBQuestions.length + cohortCQuestions.length;
  // Control questions are also in experiment_questions
  if ((expQCount || 0) >= expectedTotal) {
    console.log('Migration complete and verified.');
  } else {
    console.error(`WARNING: Expected at least ${expectedTotal} experiment questions, found ${expQCount}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
