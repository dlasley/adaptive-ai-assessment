/**
 * Read-only `llm_batch_jobs` lookups for guided workflows: finding the job a just-submitted batch
 * audit created, and listing jobs still awaiting `--llm-batch-resume`. `llm_batch_jobs` has RLS
 * enabled with no policies (service-role only, by design) — both functions take a
 * `ReadOnlySupabaseClient` (see `createServiceReadClient()` in `../db-queries.ts`), never a plain
 * anon-key client, which would run these selects successfully and silently return zero rows.
 */

import type { ReadOnlySupabaseClient } from '../db-queries';
import type { LlmBatchJobRow } from '../mistral-audit';

/** The job row `questions-audit --llm-batch` just created for `pipelineBatchId`, if any. */
export async function findLatestJobForBatch(
  supabase: ReadOnlySupabaseClient,
  pipelineBatchId: string,
): Promise<LlmBatchJobRow | null> {
  const { data, error } = await supabase
    .from('llm_batch_jobs')
    .select()
    .eq('pipeline_batch_id', pipelineBatchId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Failed to look up llm_batch_jobs for ${pipelineBatchId}: ${error.message}`);
  return (data as LlmBatchJobRow) ?? null;
}

/** Jobs not yet applied (`--llm-batch-resume ... --write-db` hasn't landed their results), most
 * recent first — the candidates "Resume a batch audit" offers. */
export async function listPendingJobs(supabase: ReadOnlySupabaseClient, limit = 20): Promise<LlmBatchJobRow[]> {
  const { data, error } = await supabase
    .from('llm_batch_jobs')
    .select()
    .is('applied_at', null)
    .order('submitted_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to list pending llm_batch_jobs: ${error.message}`);
  return (data as LlmBatchJobRow[]) ?? [];
}
