import { describe, expect, it } from 'vitest';
import { BASE_INTER_GROUP_DELAY_MS, MAX_INTER_GROUP_DELAY_MS, nextInterGroupDelay } from '../src/lib/rate-limit-delay';

describe('nextInterGroupDelay', () => {
  it('doubles on rate-limited outcomes', () => {
    let delay = BASE_INTER_GROUP_DELAY_MS;
    delay = nextInterGroupDelay(delay, 'rate-limited');
    expect(delay).toBe(2000);
    delay = nextInterGroupDelay(delay, 'rate-limited');
    expect(delay).toBe(4000);
  });

  it('caps growth at MAX_INTER_GROUP_DELAY_MS', () => {
    let delay = BASE_INTER_GROUP_DELAY_MS;
    for (let i = 0; i < 10; i++) {
      delay = nextInterGroupDelay(delay, 'rate-limited');
    }
    expect(delay).toBe(MAX_INTER_GROUP_DELAY_MS);
  });

  it('halves on ok outcomes', () => {
    let delay = MAX_INTER_GROUP_DELAY_MS;
    delay = nextInterGroupDelay(delay, 'ok');
    expect(delay).toBe(5000);
    delay = nextInterGroupDelay(delay, 'ok');
    expect(delay).toBe(2500);
  });

  it('recovers to the base delay after enough successes and never drops below it', () => {
    let delay = MAX_INTER_GROUP_DELAY_MS;
    for (let i = 0; i < 10; i++) {
      delay = nextInterGroupDelay(delay, 'ok');
    }
    expect(delay).toBe(BASE_INTER_GROUP_DELAY_MS);
  });

  it('stays at the base delay on consecutive ok outcomes when already at the base', () => {
    let delay = BASE_INTER_GROUP_DELAY_MS;
    delay = nextInterGroupDelay(delay, 'ok');
    expect(delay).toBe(BASE_INTER_GROUP_DELAY_MS);
  });

  it('recovers after a burst of rate limiting followed by sustained success', () => {
    let delay = BASE_INTER_GROUP_DELAY_MS;
    for (let i = 0; i < 5; i++) {
      delay = nextInterGroupDelay(delay, 'rate-limited');
    }
    expect(delay).toBe(MAX_INTER_GROUP_DELAY_MS);

    for (let i = 0; i < 4; i++) {
      delay = nextInterGroupDelay(delay, 'ok');
    }
    expect(delay).toBe(BASE_INTER_GROUP_DELAY_MS);
  });
});
