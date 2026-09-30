/**
 * Shared batched-write path for both auditors' `quality_status` + `audit_metadata` updates.
 *
 * Uses one `upsert()` call per chunk instead of one `.update()` per row. The streaming caller
 * (`questions-audit.ts`) already applies one row at a time (`AUDIT_GROUP_SIZE` is 1), so batching
 * doesn't change its round-trip count; the payoff is the single-shot `--llm-batch-resume` apply
 * path, which can hand this hundreds of rows in one call.
 *
 * Every row in a chunk must carry the exact same set of columns. PostgREST's upsert builds one
 * `ON CONFLICT ... DO UPDATE SET` clause shared across the whole payload, so a row that omits a
 * column present on a sibling row in the same chunk would have that column overwritten with NULL
 * instead of left alone. `buildExtraColumns`, when given, must always return a column's *current*
 * value for a row it isn't changing, never omit the key.
 *
 * Failure semantics: a failed chunk retries row by row, so one bad row never takes the other rows
 * in its chunk down with it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from './logger';

/** Rows per upsert statement; a larger apply is split into chunks of this size. */
const MAX_UPSERT_CHUNK_SIZE = 500;

export interface ApplyAuditWritesOptions<TResult> {
  /** The calling auditor's own logger, so a row-level failure logs under its usual component tag
   * (`mistral-audit` / `sonnet-audit`) instead of this module's. */
  logger: Logger;
  isError: (result: TResult) => boolean;
  isGatePass: (result: TResult) => boolean;
  buildMetadata: (result: TResult) => Record<string, unknown>;
  /** Extra columns beyond `quality_status`/`audit_metadata` (Mistral's difficulty relabeling and
   * variation cleanup). Must return every such column on every call, even when unchanged for that
   * row — see the module doc comment. Omit for an auditor with nothing to add (Sonnet). */
  buildExtraColumns?: (result: TResult) => Record<string, unknown>;
}

export interface ApplyAuditWritesResult {
  /** Ids actually confirmed written with `quality_status: 'active'`. */
  activeIds: string[];
  /** Ids actually confirmed written with `quality_status: 'flagged'`. */
  flaggedIds: string[];
  errorCount: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Writes every non-error result's `quality_status` + `audit_metadata` (+ any extra columns) in as
 * few round trips as possible, falling back to one write per row for any chunk whose batched
 * upsert fails. Returns which ids were actually confirmed written — a caller with its own
 * per-row bookkeeping (Mistral's difficulty-relabel/variation-removal counts) filters its own
 * results down to these ids before counting, so a count only ever reflects a confirmed write.
 */
export async function applyAuditWrites<TResult extends { id: string }>(
  supabase: SupabaseClient,
  results: TResult[],
  opts: ApplyAuditWritesOptions<TResult>,
): Promise<ApplyAuditWritesResult> {
  const errorResults = results.filter(opts.isError);
  const validResults = results.filter((r) => !opts.isError(r));

  const activeIds: string[] = [];
  const flaggedIds: string[] = [];

  const rowFor = (r: TResult): Record<string, unknown> => ({
    id: r.id,
    quality_status: opts.isGatePass(r) ? 'active' : 'flagged',
    audit_metadata: opts.buildMetadata(r),
    ...(opts.buildExtraColumns ? opts.buildExtraColumns(r) : {}),
  });

  const recordWritten = (r: TResult) => (opts.isGatePass(r) ? activeIds : flaggedIds).push(r.id);

  const writeRowByRow = async (rows: TResult[]): Promise<void> => {
    for (const r of rows) {
      const { id, ...updateData } = rowFor(r);
      const { error } = await supabase.from('questions').update(updateData).eq('id', id);
      if (error) {
        opts.logger.error(`Error ${opts.isGatePass(r) ? 'activating' : 'flagging'} ${r.id}`, { message: error.message });
        continue;
      }
      recordWritten(r);
    }
  };

  for (const batch of chunk(validResults, MAX_UPSERT_CHUNK_SIZE)) {
    const { error } = await supabase.from('questions').upsert(batch.map(rowFor));
    if (!error) {
      for (const r of batch) recordWritten(r);
      continue;
    }
    opts.logger.warn(
      `Batch upsert of ${batch.length} audit result(s) failed, falling back to one write per row`,
      { message: error.message },
    );
    await writeRowByRow(batch);
  }

  return { activeIds, flaggedIds, errorCount: errorResults.length };
}
