import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNextLocked, startWrongAnswerCountdown } from '@/lib/wrong-answer-countdown';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startWrongAnswerCountdown', () => {
  it('auto-advances one tick per second down to null when left alone', () => {
    const ticks: (number | null)[] = [];
    startWrongAnswerCountdown(3, (remaining) => ticks.push(remaining));

    expect(ticks).toEqual([3]);

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([3, 2]);

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([3, 2, 1]);

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([3, 2, 1, null]);
  });

  it('stops ticking immediately when skipped, without waiting for the remaining seconds', () => {
    const ticks: (number | null)[] = [];
    const countdown = startWrongAnswerCountdown(15, (remaining) => ticks.push(remaining));

    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([15, 14, 13]);

    countdown.stop();

    // The remaining 13 seconds never fire another tick.
    vi.advanceTimersByTime(15000);
    expect(ticks).toEqual([15, 14, 13]);
  });

  it('honors whatever duration it is started with, such as an admin override', () => {
    const defaultTicks: (number | null)[] = [];
    const overrideTicks: (number | null)[] = [];

    startWrongAnswerCountdown(15, (remaining) => defaultTicks.push(remaining));
    startWrongAnswerCountdown(5, (remaining) => overrideTicks.push(remaining));

    expect(defaultTicks).toEqual([15]);
    expect(overrideTicks).toEqual([5]);

    vi.advanceTimersByTime(5000);
    expect(defaultTicks).toEqual([15, 14, 13, 12, 11, 10]);
    expect(overrideTicks).toEqual([5, 4, 3, 2, 1, null]);
  });
});

describe('isNextLocked', () => {
  it('is unlocked when no countdown is running', () => {
    expect(isNextLocked(null, null, 3)).toBe(false);
    expect(isNextLocked(15, null, 3)).toBe(false);
  });

  it('locks only for the minimum wait, then unlocks while the countdown keeps running', () => {
    expect(isNextLocked(15, 15, 3)).toBe(true);
    expect(isNextLocked(15, 13, 3)).toBe(true);
    expect(isNextLocked(15, 12, 3)).toBe(false);
    expect(isNextLocked(15, 1, 3)).toBe(false);
  });

  it('never locks longer than a countdown shorter than the minimum wait', () => {
    expect(isNextLocked(2, 2, 3)).toBe(true);
    expect(isNextLocked(2, 1, 3)).toBe(true);
    expect(isNextLocked(2, null, 3)).toBe(false);
  });

  it('never locks when the minimum wait is zero', () => {
    expect(isNextLocked(15, 15, 0)).toBe(false);
  });
});
