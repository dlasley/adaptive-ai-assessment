/**
 * Global circuit breaker for repeated failed admin login attempts, layered
 * on top of the per-IP rate limit in the login route: there is a single
 * shared admin password, so a guesser rotating across many IPs can stay
 * under any one IP's limit while still working through the password space.
 * This tracks failures in aggregate, independent of IP, and raises the cost
 * of continuing once the aggregate crosses a threshold within a window —
 * independent of and in addition to the per-IP rate limiting in
 * `rate-limiter.ts`.
 */

import type { RateLimitStore } from './rate-limit-store';

const GLOBAL_FAILURE_THRESHOLD = 20;
const GLOBAL_FAILURE_WINDOW_MS = 5 * 60 * 1000;

/** Fixed delay applied to every login attempt once tightened mode is active. There is no
 * Turnstile integration on this route, so a delay is the only circuit-breaker response
 * available, unlike verify-code-guard's Turnstile-first, delay-fallback behavior. */
export const ADMIN_LOGIN_TIGHTENED_MODE_DELAY_MS = 2000;

const GLOBAL_FAIL_KEY = 'admin-login-fail-global';

/** True once failed admin login attempts, aggregated across all IPs, have
 * crossed the circuit-breaker threshold within the failure window. */
export async function isAdminLoginInTightenedMode(store: RateLimitStore): Promise<boolean> {
  const count = await store.peek(GLOBAL_FAIL_KEY);
  return count > GLOBAL_FAILURE_THRESHOLD;
}

export async function recordAdminLoginFailure(store: RateLimitStore): Promise<void> {
  await store.increment(GLOBAL_FAIL_KEY, GLOBAL_FAILURE_WINDOW_MS);
}
