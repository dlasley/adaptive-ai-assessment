import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from '@/lib/rate-limit-store';
import {
  adminLoginTightenedRetryAfterSeconds,
  isAdminLoginInTightenedMode,
  recordAdminLoginFailure,
} from '@/lib/admin-lockout-policy';

// The threshold is not exported, so these tests drive
// the boundary directly rather than importing a magic number.
const GLOBAL_FAILURE_THRESHOLD = 20;

describe('admin login global circuit breaker', () => {
  it('enters tightened mode once aggregate failures cross the threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i <= GLOBAL_FAILURE_THRESHOLD; i++) {
      await recordAdminLoginFailure(store);
    }

    expect(await isAdminLoginInTightenedMode(store)).toBe(true);
  });

  it('stays out of tightened mode under the threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < GLOBAL_FAILURE_THRESHOLD; i++) {
      await recordAdminLoginFailure(store);
    }

    expect(await isAdminLoginInTightenedMode(store)).toBe(false);
  });
});

describe('admin login retry delay', () => {
  it('reports the rest of the failure window', async () => {
    const store = new InMemoryRateLimitStore();
    await recordAdminLoginFailure(store);

    const seconds = await adminLoginTightenedRetryAfterSeconds(store);
    expect(seconds).toBeGreaterThan(4 * 60);
    expect(seconds).toBeLessThanOrEqual(5 * 60);
  });
});
