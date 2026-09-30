import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from '@/lib/rate-limit-store';
import {
  GLOBAL_FAILURE_THRESHOLD,
  PER_CODE_MAX_FAILURES,
  isCodeLockedOut,
  isInTightenedMode,
  recordCodeLookupFailure,
  recordGlobalLookupFailure,
} from '@/lib/verify-code-guard';

describe('per-code lockout', () => {
  it('locks a code string out after crossing the failure threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < PER_CODE_MAX_FAILURES; i++) {
      await recordCodeLookupFailure(store, 'guessed-code');
    }
    expect(await isCodeLockedOut(store, 'guessed-code')).toBe(false);

    await recordCodeLookupFailure(store, 'guessed-code');
    expect(await isCodeLockedOut(store, 'guessed-code')).toBe(true);
  });

  it('never locks out a different, unrelated code string', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i <= PER_CODE_MAX_FAILURES; i++) {
      await recordCodeLookupFailure(store, 'attacker-guess');
    }
    expect(await isCodeLockedOut(store, 'attacker-guess')).toBe(true);

    // A real student's own code was never recorded as a failure, so it's
    // never locked out, no matter how many failures other strings racked up.
    expect(await isCodeLockedOut(store, 'real-student-code')).toBe(false);
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

  it('stays out of tightened mode under the threshold', async () => {
    const store = new InMemoryRateLimitStore();

    for (let i = 0; i < GLOBAL_FAILURE_THRESHOLD; i++) {
      await recordGlobalLookupFailure(store);
    }

    expect(await isInTightenedMode(store)).toBe(false);
  });
});
