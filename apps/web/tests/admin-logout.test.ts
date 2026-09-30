import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/admin/logout/route';

const PROD_URL = 'french-1.vercel.app';

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
});

function logoutRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/admin/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
  });
}

describe('POST /api/admin/logout', () => {
  it('rejects a request from a disallowed origin, cookie left untouched', async () => {
    const res = await POST(logoutRequest({ origin: 'https://evil.com' }));

    expect(res.status).toBe(403);
    expect(res.cookies.get('admin_session')).toBeUndefined();
  });

  it('clears the admin session cookie for an allowed origin', async () => {
    const res = await POST(logoutRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
