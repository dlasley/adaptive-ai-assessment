/**
 * Shared write path for both auditors' `quality_status` + `audit_metadata` updates: one
 * `.update().eq('id')` per row, carrying only the columns the audit decides.
 *
 * Rows are written one at a time on purpose. A batched `upsert()` would have to carry every
 * NOT NULL column of `questions` (`question`, `correct_answer`, `unit_id`, `topic`, `difficulty`,
 * `type`, `batch_id`) on each row, because Postgres checks NOT NULL on the inserted tuple before
 * the conflict clause runs, and those values could only come from the row fetched when the audit
 * started. On the `--llm-batch-resume` apply path that fetch can be hours old, so a successful
 * upsert would overwrite any edit made in between. A per-row update cannot touch a column it does
 * not carry; the cost is one round trip per row, well under a minute for a few hundred rows.
 *
 * Failure semantics: a row whose write fails is logged and skipped; the other rows still write.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from './logger';

export interface ApplyAuditWritesOptions<TResult> {
  /** The calling auditor's own logger, so a row-level failure logs under its usual component tag
   * (`mistral-audit` / `sonnet-audit`) instead of this module's. */
  logger: Logger;
  isError: (result: TResult) => boolean;
  isGatePass: (result: TResult) => boolean;
  buildMetadata: (result: TResult) => Record<string, unknown>;
  /** Extra columns beyond `quality_status`/`audit_metadata` (Mistral's difficulty relabeling and
   * variation cleanup). Omit for an auditor with nothing to add (Sonnet). */
  buildExtraColumns?: (result: TResult) => Record<string, unknown>;
}

export interface ApplyAuditWritesResult {
  /** Ids actually confirmed written with `quality_status: 'active'`. */
  activeIds: string[];
  /** Ids actually confirmed written with `quality_status: 'flagged'`. */
  flaggedIds: string[];
  errorCount: number;
}

/**
 * Writes every non-error result's `quality_status` + `audit_metadata` (+ any extra columns), one
 * row per call. Returns which ids were actually confirmed written — a caller with its own
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

  for (const r of validResults) {
    const pass = opts.isGatePass(r);
    const updateData: Record<string, unknown> = {
      quality_status: pass ? 'active' : 'flagged',
      audit_metadata: opts.buildMetadata(r),
      ...(opts.buildExtraColumns ? opts.buildExtraColumns(r) : {}),
    };
    const { error } = await supabase.from('questions').update(updateData).eq('id', r.id);
    if (error) {
      opts.logger.error(`Error ${pass ? 'activating' : 'flagging'} ${r.id}`, { message: error.message });
      continue;
    }
    (pass ? activeIds : flaggedIds).push(r.id);
  }

  return { activeIds, flaggedIds, errorCount: errorResults.length };
}
