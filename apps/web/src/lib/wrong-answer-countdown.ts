/**
 * Drives the per-second tick of the wrong-answer countdown shown on the quiz
 * page. `onTick` is called once synchronously with the starting value, then
 * once per second with the remaining seconds, and finally with `null` once
 * the countdown reaches zero.
 */
export interface WrongAnswerCountdown {
  /** Stops the timer without reporting a final tick. */
  stop: () => void;
}

export function startWrongAnswerCountdown(
  seconds: number,
  onTick: (secondsRemaining: number | null) => void,
): WrongAnswerCountdown {
  let remaining = seconds;
  onTick(remaining);

  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      onTick(null);
      return;
    }
    onTick(remaining);
  }, 1000);

  return {
    stop: () => clearInterval(interval),
  };
}

/**
 * Whether "Next Question" is still locked. The countdown runs its full length
 * as a suggested reading time, but the button only stays disabled for the
 * first `minWaitSeconds` of it (or the whole countdown, if that is shorter).
 */
export function isNextLocked(
  totalSeconds: number | null,
  secondsRemaining: number | null,
  minWaitSeconds: number,
): boolean {
  if (totalSeconds === null || secondsRemaining === null) return false;
  const elapsed = totalSeconds - secondsRemaining;
  return elapsed < Math.min(minWaitSeconds, totalSeconds);
}
