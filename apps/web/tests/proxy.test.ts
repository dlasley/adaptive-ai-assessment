/**
 * proxy.ts only gates presence of the admin_session cookie and redirects; it sets no headers of its
 * own (the CSP/security headers are applied in next.config.ts, covered by csp.test.ts). Full HMAC
 * verification of the cookie happens per-route via requireAdmin(), not here.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

function requestTo(pathname: string, cookieValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) headers.cookie = `admin_session=${cookieValue}`;
  return new NextRequest(`https://french-1.vercel.app${pathname}`, { headers });
}

describe('proxy', () => {
  it('redirects to /admin/login when /admin is requested without a session cookie', () => {
    const res = proxy(requestTo('/admin'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://french-1.vercel.app/admin/login');
  });

  it('redirects to /admin/login when a nested /admin/* route is requested without a session cookie', () => {
    const res = proxy(requestTo('/admin/dashboard'));

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://french-1.vercel.app/admin/login');
  });

  it('does not redirect /admin/login itself, even without a session cookie', () => {
    const res = proxy(requestTo('/admin/login'));

    expect(res.status).not.toBe(307);
  });

  it('passes through a nested /admin/* route once any session cookie is present', () => {
    // Presence-only check: proxy.ts does not verify the cookie's signature, so even a garbage
    // value passes here. Full verification happens in requireAdmin() at the route level.
    const res = proxy(requestTo('/admin/dashboard', 'not-a-real-token'));

    expect(res.status).not.toBe(307);
  });

  it('passes through a non-admin route regardless of session cookie', () => {
    const res = proxy(requestTo('/quiz'));

    expect(res.status).not.toBe(307);
  });

  it('scopes the matcher to /admin/* only', () => {
    expect(config.matcher).toEqual(['/admin/:path*']);
  });
});
