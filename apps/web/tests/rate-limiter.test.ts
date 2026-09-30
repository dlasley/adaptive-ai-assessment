import { describe, expect, it } from 'vitest';
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
