/**
 * Durable, cross-instance rate limiter. Backed by Upstash Redis when
 * credentials are configured; falls back to an in-memory store for local
 * development and tests. In production with no Upstash credentials
 * configured, requests are denied (fail closed) rather than silently
 * reopening the brute-force perimeter this limiter exists to close.
 */

import { ipAddress } from '@vercel/functions';
import type { RateLimitStore } from './rate-limit-store';
import { EnvPrefixedRateLimitStore, InMemoryRateLimitStore } from './rate-limit-store';
import { createUpstashRateLimitStore } from './upstash-rate-limit-store';
import { createLogger } from './logger';
import { supabaseErrorFields } from './supabase-error';
import { isProductionMode } from './environment';

const logger = createLogger('rate-limiter');

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

let cachedStore: RateLimitStore | null | undefined;

function getStore(): RateLimitStore | null {
  if (cachedStore !== undefined) return cachedStore;

  const upstash = createUpstashRateLimitStore();
  if (upstash) {
    cachedStore = new EnvPrefixedRateLimitStore(upstash);
    return cachedStore;
  }

  if (process.env.NODE_ENV === 'production') {
    cachedStore = null;
    return cachedStore;
  }

  cachedStore = new EnvPrefixedRateLimitStore(new InMemoryRateLimitStore());
  return cachedStore;
}

/**
 * Runs the rate-limit decision against a given store. Exported separately
 * from checkRateLimit so the fail-closed-on-error behavior can be tested
 * directly against a fake store, without depending on Upstash configuration.
 */
export async function checkRateLimitWithStore(
  store: RateLimitStore | null,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  if (!store) {
    return { allowed: false, remaining: 0, resetAt: Date.now() + config.windowMs };
  }

  try {
    const { count, resetAt } = await store.increment(key, config.windowMs);
    if (count > config.maxRequests) {
      return { allowed: false, remaining: 0, resetAt };
    }
    return { allowed: true, remaining: config.maxRequests - count, resetAt };
  } catch (error) {
    logger.error('Rate limit store error, failing closed', supabaseErrorFields(error));
    return { allowed: false, remaining: 0, resetAt: Date.now() + config.windowMs };
  }
}

export function checkRateLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  return checkRateLimitWithStore(getStore(), key, config);
}

/** Exposes the resolved store for callers that need raw counters beyond checkRateLimit's sliding-window check (e.g. verify-code's per-code lockout and circuit breaker). */
export function getRateLimitStore(): RateLimitStore | null {
  return getStore();
}

/**
 * Vercel overwrites X-Forwarded-For at the edge and does not forward
 * client-supplied values (except for Enterprise projects with a trusted
 * proxy configured), so ipAddress() is safe to trust as the true client IP
 * on this project without re-parsing the header by hand.
 *
 * With no client IP, a production-mode server throws rather than put every
 * client in one shared rate-limit bucket, so the request fails instead of
 * being counted against strangers. Local development and tests fall back to
 * the loopback address.
 */
export function getClientIp(request: Request): string {
  const ip = ipAddress(request);
  if (ip) return ip;
  if (isProductionMode()) {
    logger.error('No client IP on the request; refusing to share one rate-limit bucket across clients');
    throw new Error('Client IP unavailable');
  }
  return '127.0.0.1';
}
