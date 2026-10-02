import { describe, expect, it, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import { UpstashRateLimitStore } from '@/lib/upstash-rate-limit-store';

function fakeRedis(overrides: { incr: number; pttl?: number }) {
  return {
    incr: vi.fn().mockResolvedValue(overrides.incr),
    expire: vi.fn().mockResolvedValue(1),
    pttl: vi.fn().mockResolvedValue(overrides.pttl ?? 30_000),
    get: vi.fn(),
  };
}

const asRedis = (fake: ReturnType<typeof fakeRedis>) => fake as unknown as Redis;

describe('UpstashRateLimitStore.increment', () => {
  it('sets the window TTL on the first increment', async () => {
    const redis = fakeRedis({ incr: 1 });

    const result = await new UpstashRateLimitStore(asRedis(redis)).increment('k', 60_000);

    expect(redis.expire).toHaveBeenCalledWith('k', 60);
    expect(result.count).toBe(1);
  });

  it('reports the remaining TTL on a later increment without resetting it', async () => {
    const redis = fakeRedis({ incr: 3, pttl: 20_000 });
    const before = Date.now();

    const result = await new UpstashRateLimitStore(asRedis(redis)).increment('k', 60_000);

    expect(redis.expire).not.toHaveBeenCalled();
    expect(result.count).toBe(3);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 20_000);
    expect(result.resetAt).toBeLessThan(before + 21_000);
  });

  it('restores the TTL on a key that has none, so the counter cannot block forever', async () => {
    const redis = fakeRedis({ incr: 7, pttl: -1 });
    const before = Date.now();

    const result = await new UpstashRateLimitStore(asRedis(redis)).increment('k', 60_000);

    expect(redis.expire).toHaveBeenCalledWith('k', 60);
    expect(result.resetAt).toBeGreaterThanOrEqual(before + 60_000);
  });
});
