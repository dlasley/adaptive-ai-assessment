/**
 * Brute-force defenses for verify-code, layered on top of its per-IP lookup
 * limit: a per-IP miss counter with a lock, a per-code lockout for repeated
 * failures against one string, and a global circuit breaker for a
 * distributed, low-and-slow enumeration attempt that spreads guesses across
 * many strings and IPs.
 */

import type { RateLimitStore } from './rate-limit-store';

export const PER_IP_MAX_MISSES = 20;
const PER_IP_MISS_WINDOW_MS = 5 * 60 * 1000;
const PER_IP_LOCK_MS = 5 * 60 * 1000;

export const PER_CODE_MAX_FAILURES = 5;
const PER_CODE_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const PER_CODE_COOLDOWN_MS = 15 * 60 * 1000;

export const GLOBAL_FAILURE_THRESHOLD = 50;
const GLOBAL_FAILURE_WINDOW_MS = 5 * 60 * 1000;

function perIpMissKey(ip: string): string {
  return `verify-miss-ip:${ip}`;
}

function perIpLockKey(ip: string): string {
  return `verify-lock-ip:${ip}`;
}

function perCodeFailKey(code: string): string {
  return `verify-fail-code:${code}`;
}

function perCodeLockKey(code: string): string {
  return `verify-lock-code:${code}`;
}

const GLOBAL_FAIL_KEY = 'verify-fail-global';

/** Seconds a client should wait before retrying, rounded up and never below 1. */
function retryAfterSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000));
}

/**
 * Seconds left on this IP's lock, or null when it is not locked. The lock is
 * set by recordIpMiss and covers every verify-code request from the IP, hits
 * included. Misses are counted apart from the per-IP lookup limit, so
 * successful lookups never spend the budget that guesses are held to.
 */
export async function ipLockRetryAfterSeconds(store: RateLimitStore, ip: string): Promise<number | null> {
  if ((await store.peek(perIpLockKey(ip))) === 0) return null;
  return retryAfterSeconds(await store.ttlMs(perIpLockKey(ip)));
}

/**
 * Records a not-found lookup from this IP. The PER_IP_MAX_MISSES-th miss
 * inside the miss window locks the IP for a fixed cooldown.
 */
export async function recordIpMiss(store: RateLimitStore, ip: string): Promise<void> {
  const { count } = await store.increment(perIpMissKey(ip), PER_IP_MISS_WINDOW_MS);
  if (count === PER_IP_MAX_MISSES) {
    await store.increment(perIpLockKey(ip), PER_IP_LOCK_MS);
  }
}

/**
 * Seconds left on this exact code string's lockout, or null when it is not
 * locked out after repeated failed lookups. Checked before querying
 * study_codes at all, so a locked string costs no DB round trip. Only
 * increments on a failure (a code that does not exist); a real student's
 * own code always matches on the first try, so this can never lock out a
 * legitimate owner.
 */
export async function codeLockRetryAfterSeconds(store: RateLimitStore, code: string): Promise<number | null> {
  if ((await store.peek(perCodeLockKey(code))) === 0) return null;
  return retryAfterSeconds(await store.ttlMs(perCodeLockKey(code)));
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
 * True once the aggregate not-found rate across all verify-code calls,
 * regardless of IP or code string, has crossed the circuit-breaker
 * threshold. This is the signal neither the per-IP limits nor the
 * per-code lockout catches on its own: a scan spreading one or two
 * distinct-string attempts across many rotating IPs.
 */
export async function isInTightenedMode(store: RateLimitStore): Promise<boolean> {
  const count = await store.peek(GLOBAL_FAIL_KEY);
  return count > GLOBAL_FAILURE_THRESHOLD;
}

/** Seconds until the global failure window resets, which is when tightened mode ends. */
export async function tightenedModeRetryAfterSeconds(store: RateLimitStore): Promise<number> {
  return retryAfterSeconds(await store.ttlMs(GLOBAL_FAIL_KEY));
}

export async function recordGlobalLookupFailure(store: RateLimitStore): Promise<void> {
  await store.increment(GLOBAL_FAIL_KEY, GLOBAL_FAILURE_WINDOW_MS);
}
