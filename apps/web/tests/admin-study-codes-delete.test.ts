import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { eqMock, selectRowsMock, deleteMock, fromMock } = vi.hoisted(() => {
  const selectRowsMock = vi.fn();
  const eqMock = vi.fn(() => ({ select: selectRowsMock }));
  const deleteMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn(() => ({ delete: deleteMock }));
  return { eqMock, selectRowsMock, deleteMock, fromMock };
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
  eqMock.mockClear();
  selectRowsMock.mockReset();
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
    selectRowsMock.mockResolvedValue({ data: [{ id: 'row-id' }], error: null });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(eqMock).toHaveBeenCalledWith('code', 'curious-otter');
  });

  it('404s when the study code does not exist', async () => {
    selectRowsMock.mockResolvedValue({ data: [], error: null });

    const res = await DELETE(deleteRequest(), {
      params: Promise.resolve({ code: 'unknown-code' }),
    });

    expect(res.status).toBe(404);
  });
});
