import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClientIp } from '@/lib/rate-limiter';

function makeRequest(headers: Record<string, string>): Request {
  return new Request('https://example.com/api/verify-code', { headers });
}

describe('getClientIp', () => {
  it('does not derive from a forged X-Forwarded-For header', () => {
    const spoofed = makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    // Vercel's edge sets x-real-ip, not X-Forwarded-For; with no x-real-ip
    // present, a forged X-Forwarded-For must not be picked up as a fallback.
    expect(getClientIp(spoofed)).toBe('127.0.0.1');
  });

  it('resolves the same client IP regardless of X-Forwarded-For content', () => {
    const clean = makeRequest({ 'x-real-ip': '203.0.113.5' });
    const forged = makeRequest({
      'x-real-ip': '203.0.113.5',
      'x-forwarded-for': '10.0.0.1, 10.0.0.2, 9.9.9.9',
    });

    expect(getClientIp(forged)).toBe(getClientIp(clean));
    expect(getClientIp(forged)).toBe('203.0.113.5');
  });
});

describe('getClientIp with no client IP', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('falls back to the loopback address in development and tests', () => {
    expect(getClientIp(makeRequest({}))).toBe('127.0.0.1');
  });

  it.each([
    ['a production-mode server', { NODE_ENV: 'production' }],
    ['a Vercel production deployment', { VERCEL_ENV: 'production' }],
    ['a Vercel preview deployment', { VERCEL_ENV: 'preview', NODE_ENV: 'production' }],
  ])('fails closed on %s instead of sharing one bucket', (_name, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => getClientIp(makeRequest({}))).toThrow('Client IP unavailable');
  });

  it('still resolves an IP the platform supplies in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(getClientIp(makeRequest({ 'x-real-ip': '203.0.113.5' }))).toBe('203.0.113.5');
  });
});

describe('getClientIp with TRUSTED_PROXY_IP_HEADER', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores a forwarding header when the variable is unset', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => getClientIp(makeRequest({ 'x-forwarded-for': '198.51.100.7' }))).toThrow(
      'Client IP unavailable'
    );
  });

  it('uses the last value of the named header, the entry the proxy appended', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', 'x-forwarded-for');

    expect(getClientIp(makeRequest({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('reads a single-value header such as cf-connecting-ip', () => {
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', 'cf-connecting-ip');

    expect(getClientIp(makeRequest({ 'cf-connecting-ip': '198.51.100.9' }))).toBe('198.51.100.9');
  });

  it('prefers x-real-ip from the platform over the named header', () => {
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', 'x-forwarded-for');

    expect(
      getClientIp(makeRequest({ 'x-real-ip': '203.0.113.5', 'x-forwarded-for': '198.51.100.7' }))
    ).toBe('203.0.113.5');
  });

  it('still fails closed in production when the named header is absent', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXY_IP_HEADER', 'x-forwarded-for');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => getClientIp(makeRequest({}))).toThrow('Client IP unavailable');
  });
});
