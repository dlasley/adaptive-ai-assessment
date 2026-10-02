import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from '@/lib/rate-limit-store';
import {
  GLOBAL_FAILURE_THRESHOLD,
  PER_CODE_MAX_FAILURES,
  PER_IP_MAX_MISSES,
  codeLockRetryAfterSeconds,
  ipLockRetryAfterSeconds,
  isInTightenedMode,
  recordCodeLookupFailure,
  recordGlobalLookupFailure,
  recordIpMiss,
  tightenedModeRetryAfterSeconds,
} from '@/lib/verify-code-guard';

describe('per-code lockout', () => {
  it('locks a code string out after crossing the failure threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < PER_CODE_MAX_FAILURES; i++) {
      await recordCodeLookupFailure(store, 'guessed-code');
    }
    expect(await codeLockRetryAfterSeconds(store, 'guessed-code')).toBeNull();

    await recordCodeLookupFailure(store, 'guessed-code');
    expect(await codeLockRetryAfterSeconds(store, 'guessed-code')).toBeGreaterThan(0);
  });

  it('never locks out a different, unrelated code string', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i <= PER_CODE_MAX_FAILURES; i++) {
      await recordCodeLookupFailure(store, 'attacker-guess');
    }
    expect(await codeLockRetryAfterSeconds(store, 'attacker-guess')).not.toBeNull();

    // A real student's own code was never recorded as a failure, so it's
    // never locked out, no matter how many failures other strings racked up.
    expect(await codeLockRetryAfterSeconds(store, 'real-student-code')).toBeNull();
  });
});

describe('per-IP miss lock', () => {
  it('locks an IP for 15 minutes once it reaches the miss limit', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < PER_IP_MAX_MISSES - 1; i++) {
      await recordIpMiss(store, '203.0.113.1');
    }
    expect(await ipLockRetryAfterSeconds(store, '203.0.113.1')).toBeNull();

    await recordIpMiss(store, '203.0.113.1');
    const retryAfter = await ipLockRetryAfterSeconds(store, '203.0.113.1');
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it('does not lock a different IP', async () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < PER_IP_MAX_MISSES; i++) await recordIpMiss(store, '203.0.113.1');

    expect(await ipLockRetryAfterSeconds(store, '203.0.113.2')).toBeNull();
  });
});

describe('global failure-rate circuit breaker', () => {
  it('enters tightened mode once the aggregate failure rate crosses the threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i <= GLOBAL_FAILURE_THRESHOLD; i++) {
      await recordGlobalLookupFailure(store);
    }

    expect(await isInTightenedMode(store)).toBe(true);
  });

  it('reports the rest of the failure window as the retry delay', async () => {
    const store = new InMemoryRateLimitStore();
    await recordGlobalLookupFailure(store);

    const retryAfter = await tightenedModeRetryAfterSeconds(store);
    expect(retryAfter).toBeGreaterThan(4 * 60);
    expect(retryAfter).toBeLessThanOrEqual(5 * 60);
  });

  it('stays out of tightened mode under the threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < GLOBAL_FAILURE_THRESHOLD; i++) {
      await recordGlobalLookupFailure(store);
    }

    expect(await isInTightenedMode(store)).toBe(false);
  });
});
