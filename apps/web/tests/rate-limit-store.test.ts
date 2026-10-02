import { describe, expect, it } from 'vitest';
import { checkRateLimitWithStore } from '@/lib/rate-limiter';
import { InMemoryRateLimitStore } from '@/lib/rate-limit-store';
import type { RateLimitStore } from '@/lib/rate-limit-store';

describe('checkRateLimitWithStore', () => {
  it('denies (fails closed) when no store is configured', async () => {
    const result = await checkRateLimitWithStore(null, 'k', { windowMs: 1000, maxRequests: 5 });
    expect(result.allowed).toBe(false);
  });

  it('denies (fails closed) when the store throws, not allows', async () => {
    const throwingStore: RateLimitStore = {
      increment: async () => {
        throw new Error('store unreachable');
      },
      peek: async () => 0,
      ttlMs: async () => 0,
    };

    const result = await checkRateLimitWithStore(throwingStore, 'k', {
      windowMs: 1000,
      maxRequests: 5,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('allows requests under the limit and denies once the limit is exceeded', async () => {
    const store = new InMemoryRateLimitStore();
    const config = { windowMs: 60_000, maxRequests: 2 };

    const first = await checkRateLimitWithStore(store, 'k', config);
    const second = await checkRateLimitWithStore(store, 'k', config);
    const third = await checkRateLimitWithStore(store, 'k', config);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });

  it('tracks separate keys independently', async () => {
    const store = new InMemoryRateLimitStore();
    const config = { windowMs: 60_000, maxRequests: 1 };

    const a = await checkRateLimitWithStore(store, 'a', config);
    const b = await checkRateLimitWithStore(store, 'b', config);

    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });
});

describe('InMemoryRateLimitStore.ttlMs', () => {
  it('reports the time left in a key\'s window and 0 for an absent key', async () => {
    const store = new InMemoryRateLimitStore();
    await store.increment('k', 60_000);

    const ttl = await store.ttlMs('k');
    expect(ttl).toBeGreaterThan(50_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await store.ttlMs('absent')).toBe(0);
  });
});
