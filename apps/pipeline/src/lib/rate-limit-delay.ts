/**
 * Delay policy for the pacing sleep between groups in the synchronous Mistral audit loop
 * (questions-audit.ts, --auditor mistral). Separate from the per-attempt exponential backoff used
 * to retry a single rate-limited request — this governs how long the loop waits *between* groups
 * regardless of whether the next one hits a 429.
 */

export const BASE_INTER_GROUP_DELAY_MS = 1000;
export const MAX_INTER_GROUP_DELAY_MS = 10_000;

export type InterGroupDelayOutcome = 'rate-limited' | 'ok';

/**
 * Doubles the delay on a 429, capped at `MAX_INTER_GROUP_DELAY_MS`, so a burst of rate limiting
 * backs off quickly. Halves it after a group succeeds, floored at `BASE_INTER_GROUP_DELAY_MS`, so
 * pacing recovers once the rate limiter has cleared instead of staying pinned at the cap for the
 * rest of the run.
 */
export function nextInterGroupDelay(current: number, outcome: InterGroupDelayOutcome): number {
  if (outcome === 'rate-limited') {
    return Math.min(current * 2, MAX_INTER_GROUP_DELAY_MS);
  }
  return Math.max(BASE_INTER_GROUP_DELAY_MS, Math.floor(current / 2));
}
