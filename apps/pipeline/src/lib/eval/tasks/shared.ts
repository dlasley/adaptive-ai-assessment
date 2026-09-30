/**
 * Small helpers shared by every task module in this directory.
 */

import crypto from 'crypto';
import { LlmError } from '@adaptive/shared/llm';

/** Six retries, 5 s doubling to 60 s — the retry policy every task's model call uses. */
export const MODEL_CALL_RETRY = { maxRetries: 6, initialBackoffMs: 5000, maxBackoffMs: 60000 };

// A group call's token counts are split evenly across its questions, so a per-item share can be
// fractional; the eval_results token columns are integers.
export function wholeTokens(value: number | undefined | null): number | null {
  return value === undefined || value === null ? null : Math.round(value);
}

export function isEmptyContentError(err: unknown): boolean {
  return err instanceof LlmError && /^(empty|missing) content/.test(err.message);
}

/** sha256 (16 hex) — same convention as questions-audit.ts's prompt hashing. */
export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}
