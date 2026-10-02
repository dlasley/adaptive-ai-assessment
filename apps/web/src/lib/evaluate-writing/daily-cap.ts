import { checkRateLimit } from '@/lib/rate-limiter';

export const DEFAULT_MODEL_GRADING_DAILY_CAP = 2000;

// Longer than a day so the counter outlives its UTC date; the date in the key starts each day fresh.
const COUNTER_WINDOW_MS = 25 * 60 * 60 * 1000;

/** Answers the model may grade per UTC day, from MODEL_GRADING_DAILY_CAP (default 2000). */
function modelGradingDailyCap(): number {
  const configured = Number(process.env.MODEL_GRADING_DAILY_CAP);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MODEL_GRADING_DAILY_CAP;
}

/**
 * Counts one model-graded answer against today's global allowance. False once the allowance is
 * spent, and also when the rate-limit store cannot answer, so spend stays bounded if it is down.
 */
export async function reserveModelGrading(now: Date = new Date()): Promise<boolean> {
  const utcDate = now.toISOString().slice(0, 10);
  const result = await checkRateLimit(`evaluate-model-global:${utcDate}`, {
    windowMs: COUNTER_WINDOW_MS,
    maxRequests: modelGradingDailyCap(),
  });
  return result.allowed;
}
