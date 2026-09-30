import { afterEach, describe, expect, it } from 'vitest';
import { EnvPrefixedRateLimitStore, InMemoryRateLimitStore, currentEnvironment } from '@/lib/rate-limit-store';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('currentEnvironment', () => {
  it('falls back to development when VERCEL_ENV is unset', () => {
    delete process.env.VERCEL_ENV;
    expect(currentEnvironment()).toBe('development');
  });

  it('reads VERCEL_ENV when set', () => {
    process.env.VERCEL_ENV = 'preview';
    expect(currentEnvironment()).toBe('preview');
  });
});

describe('EnvPrefixedRateLimitStore', () => {
  it('isolates counters for the same key across different environments', async () => {
    const inner = new InMemoryRateLimitStore();
    const production = new EnvPrefixedRateLimitStore(inner, 'production');
    const preview = new EnvPrefixedRateLimitStore(inner, 'preview');

    await production.increment('verify-fail-global', 60_000);
    await production.increment('verify-fail-global', 60_000);
    await production.increment('verify-fail-global', 60_000);

    // A preview run hammering the same underlying counter key must not
    // observe or contribute to production's count.
    expect(await preview.peek('verify-fail-global')).toBe(0);
    expect(await production.peek('verify-fail-global')).toBe(3);

    await preview.increment('verify-fail-global', 60_000);
    expect(await preview.peek('verify-fail-global')).toBe(1);
    expect(await production.peek('verify-fail-global')).toBe(3);
  });

  it('defaults to the current environment when none is passed explicitly', async () => {
    process.env.VERCEL_ENV = 'development';
    const inner = new InMemoryRateLimitStore();
    const store = new EnvPrefixedRateLimitStore(inner);

    await store.increment('verify-code:1.2.3.4', 60_000);

    expect(await inner.peek('development:verify-code:1.2.3.4')).toBe(1);
  });
});
