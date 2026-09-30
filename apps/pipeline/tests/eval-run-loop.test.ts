import { describe, expect, it, vi } from 'vitest';
import { runVariantsLoop, withRateLimitRetry, isRateLimitError, type VariantFinalStatus } from '../src/lib/eval/run-loop';
import { planInterleavedCalls } from '../src/lib/eval/runner';

describe('runVariantsLoop', () => {
  it('finalizes every variant completed when nothing errors and nothing is interrupted', async () => {
    const calls = planInterleavedCalls([1, 2, 3, 4], ['a', 'b'], 2);
    const finalized: Array<{ key: string; status: VariantFinalStatus; errorMessage?: string }> = [];

    const result = await runVariantsLoop({
      calls,
      activeVariantKeys: ['a', 'b'],
      variantKeyFn: (variant: string) => variant,
      processCall: async () => {},
      finalizeVariant: async (key, status, errorMessage) => {
        finalized.push({ key, status, errorMessage });
      },
      shouldStop: () => false,
    });

    expect(result.interrupted).toBe(false);
    expect(result.erroredVariantKeys.size).toBe(0);
    expect(finalized).toEqual([
      { key: 'a', status: 'completed', errorMessage: undefined },
      { key: 'b', status: 'completed', errorMessage: undefined },
    ]);
  });

  it('marks only the variant that threw as failed, and keeps processing the other variant', async () => {
    const calls = planInterleavedCalls([1, 2, 3, 4], ['a', 'b'], 2);
    const processed: string[] = [];
    const finalized: Array<{ key: string; status: VariantFinalStatus; errorMessage?: string }> = [];

    const result = await runVariantsLoop({
      calls,
      activeVariantKeys: ['a', 'b'],
      variantKeyFn: (variant: string) => variant,
      processCall: async (call) => {
        processed.push(call.variant);
        if (call.variant === 'a') throw new Error('boom');
      },
      finalizeVariant: async (key, status, errorMessage) => {
        finalized.push({ key, status, errorMessage });
      },
      shouldStop: () => false,
    });

    // Variant 'a' fails on its first call (block 0) and its second call (block 1) is skipped;
    // variant 'b' is never skipped and gets both of its calls.
    expect(processed).toEqual(['a', 'b', 'b']);
    expect(result.erroredVariantKeys.get('a')).toBe('boom');
    expect(result.erroredVariantKeys.has('b')).toBe(false);
    expect(finalized).toEqual([
      { key: 'a', status: 'failed', errorMessage: 'boom' },
      { key: 'b', status: 'completed', errorMessage: undefined },
    ]);
  });

  it('wraps a non-Error throw into a string message', async () => {
    const calls = planInterleavedCalls([1], ['a'], 25);
    let capturedError: string | undefined;

    await runVariantsLoop({
      calls,
      activeVariantKeys: ['a'],
      variantKeyFn: (variant: string) => variant,
      processCall: async () => {
        throw 'not an Error instance';
      },
      finalizeVariant: async (_key, _status, errorMessage) => {
        capturedError = errorMessage;
      },
      shouldStop: () => false,
    });

    expect(capturedError).toBe('not an Error instance');
  });

  it('marks every non-errored variant aborted when shouldStop flips mid-run, after finishing the in-flight call', async () => {
    const calls = planInterleavedCalls([1, 2, 3, 4], ['a', 'b'], 2); // 2 blocks x 2 variants = 4 calls
    const processed: string[] = [];
    const finalized: Array<{ key: string; status: VariantFinalStatus }> = [];
    let stop = false;

    const result = await runVariantsLoop({
      calls,
      activeVariantKeys: ['a', 'b'],
      variantKeyFn: (variant: string) => variant,
      processCall: async (call) => {
        processed.push(call.variant);
        // Request a stop only after the first block's two calls have both been processed —
        // the loop must finish the call already in flight before checking again.
        if (processed.length === 2) stop = true;
      },
      finalizeVariant: async (key, status) => {
        finalized.push({ key, status });
      },
      shouldStop: () => stop,
    });

    expect(result.interrupted).toBe(true);
    expect(processed).toEqual(['a', 'b']); // block 1's calls never ran
    expect(finalized).toEqual([
      { key: 'a', status: 'aborted' },
      { key: 'b', status: 'aborted' },
    ]);
  });

  it('an errored variant is marked failed, not aborted, even when interrupted afterward', async () => {
    const calls = planInterleavedCalls([1, 2, 3, 4], ['a', 'b'], 2);
    const finalized: Array<{ key: string; status: VariantFinalStatus }> = [];
    let stop = false;

    const result = await runVariantsLoop({
      calls,
      activeVariantKeys: ['a', 'b'],
      variantKeyFn: (variant: string) => variant,
      processCall: async (call) => {
        if (call.variant === 'a') throw new Error('a broke');
        stop = true; // interrupt right after processing b's first call
      },
      finalizeVariant: async (key, status) => {
        finalized.push({ key, status });
      },
      shouldStop: () => stop,
    });

    expect(result.interrupted).toBe(true);
    expect(result.erroredVariantKeys.get('a')).toBe('a broke');
    expect(finalized).toEqual([
      { key: 'a', status: 'failed' },
      { key: 'b', status: 'aborted' },
    ]);
  });

  it('calls onProgress once per successfully processed call, not for a skipped or failed one', async () => {
    const calls = planInterleavedCalls([1, 2], ['a'], 1); // 2 calls, variant 'a'
    const onProgress = vi.fn();

    await runVariantsLoop({
      calls,
      activeVariantKeys: ['a'],
      variantKeyFn: (variant: string) => variant,
      processCall: async (call) => {
        if (call.items[0] === 2) throw new Error('second call fails');
      },
      finalizeVariant: async () => {},
      shouldStop: () => false,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('finalizes a variant exactly once even if it never appears in calls (e.g. an empty item set)', async () => {
    const finalized: string[] = [];
    const result = await runVariantsLoop({
      calls: [],
      activeVariantKeys: ['a', 'b'],
      variantKeyFn: (variant: string) => variant,
      processCall: async () => {},
      finalizeVariant: async (key) => {
        finalized.push(key);
      },
      shouldStop: () => false,
    });

    expect(result.interrupted).toBe(false);
    expect(finalized).toEqual(['a', 'b']);
  });
});

describe('withRateLimitRetry', () => {
  const opts = { maxRetries: 3, initialBackoffMs: 100, maxBackoffMs: 250, sleepFn: async () => {} };

  it('retries a 429 with exponential backoff capped at maxBackoffMs, then returns the result', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRateLimitRetry(async () => {
      calls++;
      if (calls < 4) throw Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      return 'ok';
    }, { ...opts, onRateLimited: (_a, ms) => waits.push(ms) });
    expect(result).toBe('ok');
    expect(calls).toBe(4);
    expect(waits).toEqual([100, 200, 250]);
  });

  it('throws the rate-limit error once retries are exhausted', async () => {
    await expect(withRateLimitRetry(async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); }, opts))
      .rejects.toThrow('rate limit');
  });

  it('does not retry a non-rate-limit error', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => { calls++; throw new Error('bad request'); }, opts)).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  it('recognises a rate limit by status or by message', () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
    expect(isRateLimitError(new Error('Rate limit reached: new accounts are limited'))).toBe(true);
    expect(isRateLimitError(new Error('Provider returned error'))).toBe(false);
  });
});
