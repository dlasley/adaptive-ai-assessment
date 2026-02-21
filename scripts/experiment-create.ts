/**
 * Create a new experiment and snapshot the control cohort.
 *
 * Interactive mode (prompts for experiment design):
 *   npx tsx scripts/create-experiment.ts --unit unit-2
 *
 * Non-interactive mode (all flags provided, for automation):
 *   npx tsx scripts/create-experiment.ts --unit unit-2 \
 *     --name "Markdown prompt comparison" \
 *     --research-question "Does reconverted markdown improve quality?" \
 *     --hypothesis "Reconverted markdown will improve gate pass rate by 5+pp" \
 *     --variable source_material \
 *     --metric gate_pass_rate \
 *     --output-id
 *
 * Flags:
 *   --unit <unit-id>              Target unit (required)
 *   --name <name>                 Experiment name
 *   --research-question <text>    What are we trying to learn?
 *   --hypothesis <text>           Falsifiable prediction
 *   --variable <text>             Independent variable
 *   --metric <text>               Primary success metric (default: gate_pass_rate)
 *   --description <text>          Optional description
 *   --output-id                   Print only UUID to stdout (prompts go to stderr)
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import readline from 'readline';
import { MODELS } from './lib/config';
import { getGitInfo, checkGitState } from './lib/git-utils';
import { createScriptSupabase, fetchAllPages, PAGE_SIZE } from './lib/db-queries';

// ── Types ──────────────────────────────────────────────────────────────

interface CLIOptions {
  unit: string;
  name?: string;
  researchQuestion?: string;
  hypothesis?: string;
  variable?: string;
  metric?: string;
  description?: string;
  outputId: boolean;
}

interface CohortEntry {
  label: string;
  source_type: 'control' | 'generated';
  description: string;
  question_count: number;
  batch_ids: string[];
}

// ── Variable choices (for interactive prompt) ──────────────────────────

const VARIABLE_CHOICES: Record<string, string> = {
  '1': 'source_material',
  '2': 'generation_prompt',
  '3': 'generation_model',
  '4': 'validation_rules',
  '5': 'audit_model',
};

const METRIC_CHOICES: Record<string, string> = {
  '1': 'gate_pass_rate',
  '2': 'difficulty_mismatch_rate',
  '3': 'per_criterion_failure',
};

// ── CLI parsing ────────────────────────────────────────────────────────

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    unit: '',
    outputId: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--unit':
        options.unit = args[++i];
        break;
      case '--name':
        options.name = args[++i];
        break;
      case '--research-question':
        options.researchQuestion = args[++i];
        break;
      case '--hypothesis':
        options.hypothesis = args[++i];
        break;
      case '--variable':
        options.variable = args[++i];
        break;
      case '--metric':
        options.metric = args[++i];
        break;
      case '--description':
        options.description = args[++i];
        break;
      case '--output-id':
        options.outputId = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  if (!options.unit) {
    console.error('Error: --unit is required');
    printUsage();
    process.exit(1);
  }

  return options;
}

function printUsage(): void {
  console.error(`
Usage: npx tsx scripts/create-experiment.ts --unit <unit-id> [options]

Options:
  --unit <unit-id>              Target unit (required)
  --name <name>                 Experiment name
  --research-question <text>    What are we trying to learn?
  --hypothesis <text>           Falsifiable prediction
  --variable <text>             Independent variable
  --metric <text>               Primary metric (default: gate_pass_rate)
  --description <text>          Optional description
  --output-id                   Print only UUID to stdout
  `);
}

// ── Interactive prompts ────────────────────────────────────────────────

function createInterface(outputId: boolean): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: outputId ? process.stderr : process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function promptDesign(
  rl: readline.Interface,
  options: CLIOptions,
  activeCount: number,
  log: (...args: unknown[]) => void,
): Promise<{
  name: string;
  researchQuestion: string;
  hypothesis: string;
  variable: string;
  metric: string;
  description: string;
}> {

  log(`\n  Unit: ${options.unit} (${activeCount} active questions for control)\n`);

  // 1. Research question
  let researchQuestion = options.researchQuestion || '';
  if (!researchQuestion) {
    researchQuestion = await ask(rl,
      '1. Research question\n' +
      '   What are you trying to learn? Frame as a specific, answerable question.\n' +
      '   > ');
  }

  // 2. Hypothesis
  let hypothesis = options.hypothesis || '';
  if (!hypothesis) {
    hypothesis = await ask(rl,
      '\n2. Hypothesis\n' +
      '   What outcome do you predict? A good hypothesis is falsifiable\n' +
      '   and states both the expected direction and magnitude.\n' +
      '   > ');
  }

  // 3. Independent variable
  let variable = options.variable || '';
  if (!variable) {
    const choice = await ask(rl,
      '\n3. Independent variable\n' +
      '   What single factor changes between treatment cohorts?\n' +
      '     1. Source material (markdown/PDF conversion prompt)\n' +
      '     2. Generation prompt or exemplars\n' +
      '     3. Generation model\n' +
      '     4. Validation rules\n' +
      '     5. Audit model or criteria\n' +
      '     6. Other (describe)\n' +
      '   > ');
    variable = VARIABLE_CHOICES[choice] || choice;
  }

  // 4. Primary metric
  let metric = options.metric || '';
  if (!metric) {
    const choice = await ask(rl,
      '\n4. Primary success metric\n' +
      '   Which metric will determine whether the hypothesis is supported?\n' +
      '     1. Gate pass rate (recommended)\n' +
      '     2. Difficulty mismatch rate\n' +
      '     3. Per-criterion failure rates\n' +
      '     4. Other (describe)\n' +
      '   > ');
    metric = METRIC_CHOICES[choice] || choice || 'gate_pass_rate';
  }

  // 5. Name
  let name = options.name || '';
  if (!name) {
    const suggested = `${variable.replace(/_/g, ' ')} experiment`;
    name = await ask(rl,
      `\n5. Experiment name\n` +
      `   Short label for reports (suggested: "${suggested}").\n` +
      `   > `) || suggested;
  }

  // 6. Description
  let description = options.description || '';
  if (!description && !options.outputId) {
    description = await ask(rl,
      '\n6. Description (optional)\n' +
      '   Additional context or methodology notes. Press Enter to skip.\n' +
      '   > ');
  }

  return { name, researchQuestion, hypothesis, variable, metric, description };
}

// ── Pipeline config snapshot ───────────────────────────────────────────

function buildPipelineConfig(): Record<string, unknown> {
  return {
    generation_structured: MODELS.questionGenerationStructured,
    generation_typed: MODELS.questionGenerationTyped,
    validation: MODELS.answerValidation,
    audit: MODELS.audit,
    pdf_conversion: MODELS.pdfConversion,
    topic_extraction: MODELS.topicExtraction,
  };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs();

  // Output routing: --output-id sends prompts to stderr, UUID to stdout
  const log = options.outputId
    ? (...args: unknown[]) => process.stderr.write(args.join(' ') + '\n')
    : console.log;

  // 1. Git safety
  const git = getGitInfo();
  log(`\nNew Experiment Setup\n`);
  log(`Git: branch ${git.branch} @ ${git.commit} (${git.clean ? 'clean' : 'dirty'})`);
  checkGitState({ experimentId: 'new' });

  // 2. Init Supabase (requires secret key for writes)
  const supabase = createScriptSupabase({ write: true });

  // 3. Count active questions for this unit
  const { count: activeCount, error: countError } = await supabase
    .from('questions')
    .select('*', { count: 'exact', head: true })
    .eq('unit_id', options.unit)
    .eq('quality_status', 'active');

  if (countError) {
    log(`Error counting questions: ${countError.message}`);
    process.exit(1);
  }

  if (!activeCount || activeCount === 0) {
    log(`Error: No active questions found for ${options.unit}`);
    process.exit(1);
  }

  // 4. Interactive prompts (or CLI flags)
  const rl = createInterface(options.outputId);
  const design = await promptDesign(rl, options, activeCount, log);
  rl.close();

  // 5. Fetch control questions
  log(`\nSnapshotting ${activeCount} active questions...`);

  const controlQuestions = await fetchAllPages<any>(
    supabase,
    'questions',
    (q: any) => q.eq('unit_id', options.unit).eq('quality_status', 'active'),
  );

  // 6. Aggregate distinct batch_ids from control questions
  const batchIds = [...new Set(controlQuestions.map((q: any) => q.batch_id).filter(Boolean))];

  // 7. Build control cohort entry
  const controlCohort: CohortEntry = {
    label: 'control',
    source_type: 'control',
    description: `Current active ${options.unit} questions`,
    question_count: controlQuestions.length,
    batch_ids: batchIds,
  };

  // 8. Create experiment record
  const { data: experiment, error: insertError } = await supabase
    .from('experiments')
    .insert({
      unit_id: options.unit,
      name: design.name,
      research_question: design.researchQuestion,
      hypothesis: design.hypothesis,
      independent_variable: design.variable,
      primary_metric: design.metric,
      description: design.description || null,
      git_branch: git.branch,
      git_commit: git.commit,
      pipeline_config: buildPipelineConfig(),
      cohorts: [controlCohort],
    })
    .select('id')
    .single();

  if (insertError || !experiment) {
    log(`Error creating experiment: ${insertError?.message || 'No data returned'}`);
    process.exit(1);
  }

  const experimentId = experiment.id;

  // 9. Insert control questions into experiment_questions
  // Process in batches to avoid Supabase payload limits
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < controlQuestions.length; i += BATCH_SIZE) {
    const batch = controlQuestions.slice(i, i + BATCH_SIZE).map((q: any) => ({
      experiment_id: experimentId,
      cohort: 'control',
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

    const { error: batchError } = await supabase
      .from('experiment_questions')
      .insert(batch);

    if (batchError) {
      log(`Error inserting control batch: ${batchError.message}`);
      process.exit(1);
    }

    inserted += batch.length;
  }

  // 10. Print summary
  log(`\nExperiment created: ${experimentId}`);
  log(`  Control: ${inserted} active ${options.unit} questions snapshotted`);
  log(`  Batches: ${batchIds.join(', ')}`);
  log(`  Branch: ${git.branch}`);
  log(`  Commit: ${git.commit}`);
  log(`  Ready for cohort generation.`);

  // --output-id: print UUID to stdout for shell capture
  if (options.outputId) {
    process.stdout.write(experimentId + '\n');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
