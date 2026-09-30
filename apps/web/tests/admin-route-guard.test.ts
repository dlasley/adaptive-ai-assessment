import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createSessionCookie, getAdminCookieName } from '@/lib/admin-session';
import { requireAdmin } from '@/lib/admin-route-guard';

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = 'test-admin-secret';
});

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers.cookie = `${getAdminCookieName()}=${cookieValue}`;
  }
  return new NextRequest('https://french-1.vercel.app/api/admin/stats', { headers });
}

describe('requireAdmin', () => {
  it('returns null (passes through) for a validly signed, unexpired session cookie', () => {
    const cookie = createSessionCookie();

    expect(requireAdmin(requestWithCookie(cookie.value))).toBeNull();
  });

  it('returns a 401 response when no cookie is present', async () => {
    const result = requireAdmin(requestWithCookie());

    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    expect(await result?.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns a 401 response for a garbage cookie value', () => {
    const result = requireAdmin(requestWithCookie('not-a-real-token'));

    expect(result?.status).toBe(401);
  });

  it('returns a 401 response for a tampered cookie', () => {
    const cookie = createSessionCookie();
    const outer = JSON.parse(Buffer.from(cookie.value, 'base64').toString());
    const data = JSON.parse(outer.data);
    data.expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
    outer.data = JSON.stringify(data);
    const tampered = Buffer.from(JSON.stringify(outer)).toString('base64');

    const result = requireAdmin(requestWithCookie(tampered));

    expect(result?.status).toBe(401);
  });
});
