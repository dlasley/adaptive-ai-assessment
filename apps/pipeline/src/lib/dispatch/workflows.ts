/**
 * Named, multi-step guided workflows — declared here as data (`WORKFLOWS`) so adding one later
 * means adding an entry, not touching the guided-mode UI. Each step shows the direct `pipeline`
 * command it's about to run, asks to continue, and stops the workflow on a non-zero exit code.
 */

import { confirm, input, select } from '@inquirer/prompts';
import { createServiceReadClient } from '../db-queries';
import { findLatestJobForBatch, listPendingJobs } from './batch-jobs';
import { spawnCommand } from './spawn-command';
import { formatCommandLine } from './guided-argv';
import { previewSupabaseTarget, printUnconfirmedTargetHelp } from './supabase-target-preview';

export interface Workflow {
  id: string;
  name: string;
  description: string;
  run: (commandsDir: string) => Promise<void>;
}

/** Runs one step: prints the direct command, asks to continue, and reports whether the workflow
 * should proceed to its next step. */
async function runStep(label: string, commandsDir: string, command: string, args: string[]): Promise<boolean> {
  console.log(`\n${label}`);
  console.log(`  ${formatCommandLine(command, args)}`);

  const proceed = await confirm({ message: 'Run this step?', default: true });
  if (!proceed) {
    console.log('Stopped.');
    return false;
  }

  const result = await spawnCommand(command, args, { commandsDir });
  if (result.code !== 0) {
    console.error(`Step failed (exit ${result.code ?? 'unknown'}). Stopping workflow.`);
    return false;
  }
  return true;
}

function batchIdFor(unitId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `ingest-${unitId}-${stamp}`;
}

/**
 * Convert -> extract-topics-with-review + generate -> submit batch audit. Steps 1-2 run through
 * `pipeline-run` rather than re-implementing its convert/topic-extraction/new-unit-upsert
 * sequencing here: `--review-topics` already prompts for topic review mid-run, and a brand new
 * unit's auto-upsert into the `units` table only happens inside `pipeline-run`'s own process,
 * where the topics extraction step's output is already in scope.
 */
const ingestUnit: Workflow = {
  id: 'ingest-unit',
  name: 'Ingest a new unit',
  description: 'Convert PDF(s), review extracted topics, generate questions, submit a Mistral batch audit',
  async run(commandsDir) {
    const unitId = await input({
      message: 'Unit id (matches PDF filenames, e.g. unit-5)',
      validate: (v) => (v.trim() ? true : 'Required'),
    });
    const batchId = batchIdFor(unitId);

    // Every write-capable step below targets the same database, so one check covers the workflow,
    // and it runs before step 1 so a refused target never leaves a half-finished run.
    if (!previewSupabaseTarget()) {
      printUnconfirmedTargetHelp();
      return;
    }

    const converted = await runStep('Step 1/3 — Convert PDF(s) to markdown', commandsDir, 'pipeline-run', [
      unitId,
      '--convert-only',
    ]);
    if (!converted) return;

    const generated = await runStep(
      'Step 2/3 — Extract topics (reviewed) and generate questions',
      commandsDir,
      'pipeline-run',
      [unitId, '--review-topics', '--write-db', '--skip-resources', '--batch-id', batchId],
    );
    if (!generated) return;

    const submitted = await runStep(
      'Step 3/3 — Submit Mistral Large 3 batch audit',
      commandsDir,
      'questions-audit',
      ['--unit', unitId, '--batch-id', batchId, '--pending-only', '--llm-batch'],
    );
    if (!submitted) return;

    const supabase = createServiceReadClient();
    const job = await findLatestJobForBatch(supabase, batchId);
    console.log('');
    if (job) {
      console.log('Batch submitted. Resume it once it completes (can take up to ~24h) with:');
      console.log(`  pipeline questions-audit --llm-batch-resume ${job.id} --write-db`);
    } else {
      console.log(`Batch submitted, but its job row couldn't be looked up automatically.`);
      console.log(`Find it with pipeline_batch_id = '${batchId}' in llm_batch_jobs, or use the`);
      console.log(`"Resume a batch audit" workflow, which lists pending jobs.`);
    }
  },
};

const resumeBatchAudit: Workflow = {
  id: 'resume-batch-audit',
  name: 'Resume a batch audit',
  description: 'List pending llm_batch_jobs rows and resume one',
  async run(commandsDir) {
    // Applying results writes to the database, so check the target before listing jobs.
    if (!previewSupabaseTarget()) {
      printUnconfirmedTargetHelp();
      return;
    }
    const supabase = createServiceReadClient();
    const jobs = await listPendingJobs(supabase);

    if (jobs.length === 0) {
      console.log('No pending batch jobs (none with applied_at IS NULL).');
      return;
    }

    const jobId = await select({
      message: 'Which job?',
      choices: jobs.map((job) => ({
        name: `${job.pipeline_batch_id} — ${job.unit_id ?? 'all units'} — ${job.status} — submitted ${job.submitted_at}`,
        value: job.id,
      })),
    });

    await runStep('Resume batch audit', commandsDir, 'questions-audit', ['--llm-batch-resume', jobId, '--write-db']);
  },
};

const WORKFLOWS: Workflow[] = [ingestUnit, resumeBatchAudit];

export function listWorkflows(): Workflow[] {
  return WORKFLOWS;
}

export async function runWorkflow(id: string, commandsDir: string): Promise<void> {
  const workflow = WORKFLOWS.find((w) => w.id === id);
  if (!workflow) {
    console.error(`Unknown workflow: ${id}`);
    return;
  }
  await workflow.run(commandsDir);
}
