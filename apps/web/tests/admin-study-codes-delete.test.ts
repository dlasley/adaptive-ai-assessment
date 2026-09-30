import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { eqMock, deleteMock, fromMock } = vi.hoisted(() => {
  const eqMock = vi.fn();
  const deleteMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn(() => ({ delete: deleteMock }));
  return { eqMock, deleteMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/admin-route-guard', () => ({
  requireAdmin: () => null,
}));

import { DELETE } from '@/app/api/admin/study-codes/[code]/route';

const PROD_URL = 'french-1.vercel.app';

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  eqMock.mockReset();
  deleteMock.mockClear();
  fromMock.mockClear();
});

function deleteRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/admin/study-codes/curious-otter', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
  });
}

describe('DELETE /api/admin/study-codes/[code]', () => {
  it('rejects a request from a disallowed origin before touching the database', async () => {
    const res = await DELETE(deleteRequest({ origin: 'https://evil.com' }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('deletes the study code when the origin is allowed', async () => {
    eqMock.mockResolvedValue({ error: null });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(eqMock).toHaveBeenCalledWith('code', 'curious-otter');
  });
});
