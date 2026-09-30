/**
 * Shared logic for `questions-audit.ts`'s Sonnet auditor path: the 4-criteria audit result shape
 * and the quality_status/audit_metadata write-db logic. Sonnet evaluates a narrower core than
 * Mistral (no remediation — no difficulty relabeling, no variation removal). Split into a
 * per-group write (no console output) and a report printer, so a streaming caller can apply each
 * group's results as soon as it completes and still print one aggregated report at the end,
 * matching `mistral-audit.ts`'s split.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { applyAuditWrites } from './audit-write';
import { createLogger } from './logger';

const logger = createLogger('sonnet-audit');

export interface SonnetAuditResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  notes: string;
  /** This call's usage — one question per call, so nothing to divide (unlike Mistral's grouped
   * audit). Null if the call carried no usage data. */
  usage: { prompt_tokens: number | null; completion_tokens: number | null; reasoning_tokens: number | null; cost_usd: number | null } | null;
  served_model: string | null;
}

export interface ApplySonnetAuditResultsSummary {
  activeCount: number;
  flaggedCount: number;
  errorCount: number;
}

export const EMPTY_SONNET_AUDIT_RESULTS_SUMMARY: ApplySonnetAuditResultsSummary = {
  activeCount: 0,
  flaggedCount: 0,
  errorCount: 0,
};

export function mergeSonnetAuditResultsSummaries(
  a: ApplySonnetAuditResultsSummary,
  b: ApplySonnetAuditResultsSummary,
): ApplySonnetAuditResultsSummary {
  return {
    activeCount: a.activeCount + b.activeCount,
    flaggedCount: a.flaggedCount + b.flaggedCount,
    errorCount: a.errorCount + b.errorCount,
  };
}

const isParseError = (r: SonnetAuditResult) => r.notes.startsWith('PARSE_ERROR:');

const isGatePass = (r: SonnetAuditResult) =>
  r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent;

function buildAuditMetadata(r: SonnetAuditResult, auditorModel: string, promptHash?: string) {
  return {
    auditor: 'sonnet',
    model: auditorModel,
    audited_at: new Date().toISOString(),
    gate_criteria: {
      answer_correct: r.answer_correct,
      grammar_correct: r.grammar_correct,
      no_hallucination: r.no_hallucination,
      question_coherent: r.question_coherent,
    },
    notes: r.notes,
    usage: r.usage,
    served_model: r.served_model,
    prompt_hash: promptHash ?? null,
  };
}

/** Writes one group's quality_status + audit_metadata to `questions`. No console output — see
 * the module doc comment for how a streaming caller and a single-shot caller each use this.
 * `promptHash` is the rendered audit system prompt's sha256 (16 hex), stored for provenance. */
export async function applySonnetAuditResultsForGroup(
  supabase: SupabaseClient,
  results: SonnetAuditResult[],
  auditorModel: string,
  promptHash?: string,
): Promise<ApplySonnetAuditResultsSummary> {
  const { activeIds, flaggedIds, errorCount } = await applyAuditWrites(supabase, results, {
    logger,
    isError: isParseError,
    isGatePass,
    buildMetadata: (r) => buildAuditMetadata(r, auditorModel, promptHash),
  });

  return { activeCount: activeIds.length, flaggedCount: flaggedIds.length, errorCount };
}

/** Prints the same "WRITING QUALITY STATUS..." report against a summary that may be the
 * accumulated total of several `applySonnetAuditResultsForGroup()` calls. */
export function summarizeSonnetAuditResultsWrite(summary: ApplySonnetAuditResultsSummary, pendingOnly: boolean): void {
  console.log('\n' + '='.repeat(60));
  console.log('WRITING QUALITY STATUS + AUDIT METADATA TO DATABASE');
  console.log('='.repeat(60));

  if (summary.flaggedCount > 0) {
    console.log(`  Marked ${summary.flaggedCount} questions as 'flagged' (with audit_metadata)`);
  }

  if (summary.activeCount > 0) {
    console.log(`  Marked ${summary.activeCount} questions as 'active' (with audit_metadata)`);
  }

  if (summary.errorCount > 0) {
    console.log(`  Skipped ${summary.errorCount} questions with parse errors (status unchanged)`);
  }

  if (pendingOnly) {
    console.log('\n  Promotion summary (pending questions, counts are successful database writes):');
    console.log(`    Promoted to active:  ${summary.activeCount}`);
    console.log(`    Flagged:             ${summary.flaggedCount}`);
    if (summary.errorCount > 0) {
      console.log(`    Still pending:       ${summary.errorCount} (parse errors)`);
    }
  }
}
