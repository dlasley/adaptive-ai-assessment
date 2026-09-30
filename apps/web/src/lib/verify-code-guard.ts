/**
 * Brute-force defenses for verify-code, layered on top of its per-IP rate
 * limit: a per-code lockout for repeated failures against one string, and
 * a global circuit breaker for a distributed, low-and-slow enumeration
 * attempt that spreads guesses across many strings and IPs.
 */

import type { RateLimitStore } from './rate-limit-store';

export const PER_CODE_MAX_FAILURES = 5;
const PER_CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PER_CODE_COOLDOWN_MS = 15 * 60 * 1000;

export const GLOBAL_FAILURE_THRESHOLD = 50;
const GLOBAL_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const TIGHTENED_MODE_DELAY_MS = 2000;

function perCodeFailKey(code: string): string {
  return `verify-fail-code:${code}`;
}

function perCodeLockKey(code: string): string {
  return `verify-lock-code:${code}`;
}

const GLOBAL_FAIL_KEY = 'verify-fail-global';

/**
 * True when this exact code string is currently locked out after repeated
 * failed lookups. Checked before querying study_codes at all, so a locked
 * string costs no DB round trip. Only increments on a failure (a code that
 * does not exist) — a real student's own code always matches on the first
 * try, so this can never lock out a legitimate owner.
 */
export async function isCodeLockedOut(store: RateLimitStore, code: string): Promise<boolean> {
  const count = await store.peek(perCodeLockKey(code));
  return count > 0;
}

/**
 * Records a failed lookup for this exact code string. Once failures for
 * this string cross the threshold within the failure window, locks the
 * string out for a fixed cooldown period.
 */
export async function recordCodeLookupFailure(store: RateLimitStore, code: string): Promise<void> {
  const { count } = await store.increment(perCodeFailKey(code), PER_CODE_FAILURE_WINDOW_MS);
  if (count === PER_CODE_MAX_FAILURES + 1) {
    await store.increment(perCodeLockKey(code), PER_CODE_COOLDOWN_MS);
  }
}

/**
 * True once the aggregate not-found rate across all verify-code calls —
 * regardless of IP or code string — has crossed the circuit-breaker
 * threshold. This is the signal neither the per-IP rate limit nor the
 * per-code lockout catches on its own: a scan spreading one or two
 * distinct-string attempts across many rotating IPs.
 */
export async function isInTightenedMode(store: RateLimitStore): Promise<boolean> {
  const count = await store.peek(GLOBAL_FAIL_KEY);
  return count > GLOBAL_FAILURE_THRESHOLD;
}

export async function recordGlobalLookupFailure(store: RateLimitStore): Promise<void> {
  await store.increment(GLOBAL_FAIL_KEY, GLOBAL_FAILURE_WINDOW_MS);
}
