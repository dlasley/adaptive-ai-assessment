import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const from = vi.fn();
const checkRateLimit = vi.fn();

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit,
  getClientIp: () => '203.0.113.7',
}));

const { POST } = await import('@/app/api/generate-code/route');

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://french-1.vercel.app/api/generate-code', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'french-1.vercel.app';
  delete process.env.VERCEL_URL;
  from.mockReset();
  checkRateLimit.mockReset();
});

describe('POST /api/generate-code CSRF protection', () => {
  it('rejects a cross-site request before rate limiting or touching the database', async () => {
    const response = await POST(
      makeRequest({ origin: 'https://evil.com', 'content-type': 'application/json' })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects a form-style request that is not JSON', async () => {
    const response = await POST(
      makeRequest({ origin: 'https://french-1.vercel.app', 'content-type': 'text/plain' })
    );

    expect(response.status).toBe(415);
    expect(from).not.toHaveBeenCalled();
  });
});
