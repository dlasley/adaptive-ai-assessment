/**
 * Global circuit breaker for repeated failed admin login attempts, layered
 * on top of the per-IP rate limit in the login route: there is a single
 * shared admin password, so a guesser rotating across many IPs can stay
 * under any one IP's limit while still working through the password space.
 * This tracks failures in aggregate, independent of IP, and once the
 * aggregate crosses a threshold within a window the login route denies every
 * attempt until the window ends, independent of and in addition to the
 * per-IP rate limiting in `rate-limiter.ts`.
 */

import type { RateLimitStore } from './rate-limit-store';

const GLOBAL_FAILURE_THRESHOLD = 20;
const GLOBAL_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const GLOBAL_FAIL_KEY = 'admin-login-fail-global';

/** True once failed admin login attempts, aggregated across all IPs, have
 * crossed the circuit-breaker threshold within the failure window. */
export async function isAdminLoginInTightenedMode(store: RateLimitStore): Promise<boolean> {
  const count = await store.peek(GLOBAL_FAIL_KEY);
  return count > GLOBAL_FAILURE_THRESHOLD;
}

/** Seconds until the failure window resets, which is when tightened mode ends. */
export async function adminLoginTightenedRetryAfterSeconds(store: RateLimitStore): Promise<number> {
  return Math.max(1, Math.ceil((await store.ttlMs(GLOBAL_FAIL_KEY)) / 1000));
}

export async function recordAdminLoginFailure(store: RateLimitStore): Promise<void> {
  await store.increment(GLOBAL_FAIL_KEY, GLOBAL_FAILURE_WINDOW_MS);
}

export const ADMIN_PER_IP_MAX_MISSES = 5;
const PER_IP_MISS_WINDOW_MS = 5 * 60 * 1000;
const PER_IP_LOCK_MS = 5 * 60 * 1000;

function perIpMissKey(ip: string): string {
  return `admin-login-miss-ip:${ip}`;
}

function perIpLockKey(ip: string): string {
  return `admin-login-lock-ip:${ip}`;
}

/**
 * Seconds left on this IP's login lock, or null when it is not locked. The
 * lock is set by recordAdminLoginIpMiss, so one source locks itself out
 * before its failures can reach the global breaker's threshold.
 */
export async function adminLoginIpLockRetryAfterSeconds(store: RateLimitStore, ip: string): Promise<number | null> {
  if ((await store.peek(perIpLockKey(ip))) === 0) return null;
  return Math.max(1, Math.ceil((await store.ttlMs(perIpLockKey(ip))) / 1000));
}

/**
 * Records a failed login (wrong password or unreadable body) from this IP.
 * The ADMIN_PER_IP_MAX_MISSES-th miss inside the miss window locks the IP for
 * a fixed cooldown.
 */
export async function recordAdminLoginIpMiss(store: RateLimitStore, ip: string): Promise<void> {
  const { count } = await store.increment(perIpMissKey(ip), PER_IP_MISS_WINDOW_MS);
  if (count === ADMIN_PER_IP_MAX_MISSES) {
    await store.increment(perIpLockKey(ip), PER_IP_LOCK_MS);
  }
}
