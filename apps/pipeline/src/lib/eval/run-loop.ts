/**
 * Generic per-variant run loop for `eval-run`: processes interleaved calls across every active
 * variant, isolating a failure to the one variant it happened on rather than aborting the others,
 * and finalizes every variant exactly once with a status that reflects what actually happened to it
 * (`completed`/`failed`/`aborted`) — so a run row is never left `running` once this returns.
 * Separated from `eval-run.ts` so the orchestration (error isolation, SIGINT handling, finalize
 * sequencing) is unit-testable without a live Supabase connection or LLM calls, the same reasoning
 * `streaming-audit.ts` uses for `questions-audit.ts`'s loop.
 */

import type { InterleavedCall } from './runner';

export type VariantFinalStatus = 'completed' | 'failed' | 'aborted';

export interface RunVariantsLoopOptions<TItem, TVariant> {
  calls: InterleavedCall<TItem, TVariant>[];
  /** Every variant this invocation is running, keyed the same way `processCall`'s calls are. */
  activeVariantKeys: string[];
  variantKeyFn: (variant: TVariant) => string;
  /**
   * Processes one call. Per-item failures the caller already knows how to handle (a bad model
   * response, a parse error) must be caught inside this function and folded into that item's own
   * result — only a failure that escapes here marks the whole variant `failed`.
   */
  processCall: (call: InterleavedCall<TItem, TVariant>) => Promise<void>;
  /**
   * Finalizes one variant: writes whatever results accumulated for it and updates its run row to a
   * terminal status. Called exactly once per variant in `activeVariantKeys`, regardless of whether
   * that variant errored, was interrupted, or completed normally. Must not throw — a failure to
   * finalize one variant should not prevent finalizing the others; catch and log internally.
   */
  finalizeVariant: (variantKey: string, status: VariantFinalStatus, errorMessage?: string) => Promise<void>;
  /** Checked before each call; once true, the loop finishes no further calls and every variant
   * that didn't already error is finalized `aborted`. */
  shouldStop: () => boolean;
  onProgress?: (call: InterleavedCall<TItem, TVariant>) => void;
}

export interface RunVariantsLoopResult {
  interrupted: boolean;
  erroredVariantKeys: Map<string, string>;
}

export async function runVariantsLoop<TItem, TVariant>(opts: RunVariantsLoopOptions<TItem, TVariant>): Promise<RunVariantsLoopResult> {
  const erroredVariantKeys = new Map<string, string>();
  let interrupted = false;

  for (const call of opts.calls) {
    if (opts.shouldStop()) {
      interrupted = true;
      break;
    }
    const key = opts.variantKeyFn(call.variant);
    if (erroredVariantKeys.has(key)) continue; // this variant already failed unexpectedly; skip its remaining calls

    try {
      await opts.processCall(call);
      opts.onProgress?.(call);
    } catch (err) {
      erroredVariantKeys.set(key, err instanceof Error ? err.message : String(err));
    }
  }

  for (const key of opts.activeVariantKeys) {
    const variantError = erroredVariantKeys.get(key);
    const status: VariantFinalStatus = variantError !== undefined ? 'failed' : interrupted ? 'aborted' : 'completed';
    await opts.finalizeVariant(key, status, variantError);
  }

  return { interrupted, erroredVariantKeys };
}

export interface RateLimitRetryOptions {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  /** Called before each wait with the attempt index (0-based) and the wait in ms. */
  onRateLimited?: (attempt: number, backoffMs: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Whether an error is a rate limit: an HTTP 429 from the LLM client, or any error whose text
 * says so (OpenRouter wraps some upstream limits as 4xx with a "rate limit" message). */
export function isRateLimitError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 429 || String(err).toLowerCase().includes('rate limit');
}

/**
 * Runs `call`, retrying on a rate-limit error with exponential backoff up to `maxRetries`. Any
 * other error, and a rate limit that outlasts the retries, is thrown to the caller unchanged, so
 * the per-item error classification stays where it is.
 */
export async function withRateLimitRetry<T>(call: () => Promise<T>, opts: RateLimitRetryOptions): Promise<T> {
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= opts.maxRetries) throw err;
      const backoff = Math.min(opts.initialBackoffMs * Math.pow(2, attempt), opts.maxBackoffMs);
      opts.onRateLimited?.(attempt, backoff);
      await sleep(backoff);
    }
  }
}
