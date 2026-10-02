import 'server-only';
import { Redis } from '@upstash/redis';
import type { RateLimitStore } from './rate-limit-store';

/**
 * Fixed-window counter backed by Upstash Redis: INCR the key, and on the
 * first increment of a window set its TTL so the key expires on its own.
 * INCR and EXPIRE are separate calls, so a failure between them can leave a
 * key without a TTL; a later increment that finds no TTL sets it again, so
 * the counter never outlives its window.
 */
export class UpstashRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
    const count = await this.redis.incr(key);

    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
      return { count, resetAt: Date.now() + windowMs };
    }

    const ttlMs = await this.redis.pttl(key);
    if (ttlMs < 0) {
      await this.redis.expire(key, windowSeconds);
      return { count, resetAt: Date.now() + windowMs };
    }
    return { count, resetAt: Date.now() + ttlMs };
  }

  async peek(key: string): Promise<number> {
    const value = await this.redis.get<number>(key);
    return value ?? 0;
  }
}

/**
 * Reads Upstash credentials from whichever env vars the deployment
 * provides. The Vercel Marketplace Upstash integration typically sets
 * KV_REST_API_URL/KV_REST_API_TOKEN; some setups instead (or additionally)
 * provide UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN. Both are
 * supported so provisioning details don't dictate which names to read.
 */
function resolveUpstashConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export function createUpstashRateLimitStore(): UpstashRateLimitStore | null {
  const config = resolveUpstashConfig();
  if (!config) return null;
  return new UpstashRateLimitStore(new Redis({ url: config.url, token: config.token }));
}
