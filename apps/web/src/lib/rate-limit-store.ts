/**
 * Storage backend for the durable rate limiter. Each implementation
 * atomically increments a fixed-window counter for a key and reports when
 * that window resets, so the rate-limit decision logic is backend-agnostic.
 */
export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  /** Current count for a key without incrementing it. 0 if absent or expired. */
  peek(key: string): Promise<number>;
  /** Milliseconds until the key's window resets. 0 if the key is absent or expired. */
  ttlMs(key: string): Promise<number>;
}

/**
 * Per-process fixed-window counter. Used for local development and tests,
 * where no durable cross-instance store is configured. Never selected in
 * production — see rate-limiter.ts's fail-closed policy for that case.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      const window = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, window);
      return window;
    }

    existing.count += 1;
    return existing;
  }

  async peek(key: string): Promise<number> {
    const existing = this.windows.get(key);
    if (!existing || Date.now() >= existing.resetAt) return 0;
    return existing.count;
  }

  async ttlMs(key: string): Promise<number> {
    const existing = this.windows.get(key);
    if (!existing) return 0;
    return Math.max(0, existing.resetAt - Date.now());
  }
}

/** Vercel's deployment environment, defaulting to 'development' for local runs and tests where VERCEL_ENV is unset. */
export function currentEnvironment(): string {
  return process.env.VERCEL_ENV || 'development';
}

/**
 * Prefixes every key with the deployment environment before delegating to
 * the wrapped store. Production, Preview, and Development share one Upstash
 * instance, so without this a Preview run's rate-limit counters, per-code
 * lockouts, and circuit breaker would accumulate in the same keyspace as
 * Production's — letting preview testing tighten or lock out real traffic.
 */
export class EnvPrefixedRateLimitStore implements RateLimitStore {
  constructor(
    private readonly inner: RateLimitStore,
    private readonly environment: string = currentEnvironment()
  ) {}

  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    return this.inner.increment(`${this.environment}:${key}`, windowMs);
  }

  peek(key: string): Promise<number> {
    return this.inner.peek(`${this.environment}:${key}`);
  }

  ttlMs(key: string): Promise<number> {
    return this.inner.ttlMs(`${this.environment}:${key}`);
  }
}
