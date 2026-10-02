import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createSessionCookie, getAdminCookieName } from '@/lib/admin-session';
import { GET } from '@/app/api/admin/verify/route';

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = 'test-admin-secret-0123456789abcdef0123456789';
});

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers.cookie = `${getAdminCookieName()}=${cookieValue}`;
  }
  return new NextRequest('https://french-1.vercel.app/api/admin/verify', { headers });
}

describe('GET /api/admin/verify', () => {
  it('reports authenticated for a validly signed, unexpired cookie', async () => {
    const cookie = createSessionCookie();

    const res = await GET(requestWithCookie(cookie.value));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ authenticated: true });
  });

  it('reports unauthenticated when no cookie is present', async () => {
    const res = await GET(requestWithCookie());
    const body = await res.json();

    expect(body).toEqual({ authenticated: false });
  });

  it('reports unauthenticated for a garbage cookie value', async () => {
    const res = await GET(requestWithCookie('not-a-real-token'));
    const body = await res.json();

    expect(body).toEqual({ authenticated: false });
  });
});
