import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { singleMock, updateEqMock, updateMock, fromMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const updateEqMock = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'row-id' }], error: null }) }));
  const updateMock = vi.fn(() => ({ eq: updateEqMock }));
  const fromMock = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ single: singleMock })) })),
    update: updateMock,
  }));
  return { singleMock, updateEqMock, updateMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/admin-route-guard', () => ({
  requireAdmin: () => null,
}));

import { PATCH } from '@/app/api/admin/study-codes/[code]/route';

const PROD_URL = 'french-1.vercel.app';

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  updateEqMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();
});

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/admin/study-codes/curious-otter', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/admin/study-codes/[code] forceLogout', () => {
  it('bumps session_epoch by one', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 3 }, error: null });

    const res = await PATCH(patchRequest({ forceLogout: true }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ session_epoch: 4 }));
  });

  it('404s when the study code does not exist', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const res = await PATCH(patchRequest({ forceLogout: true }), {
      params: Promise.resolve({ code: 'unknown-code' }),
    });

    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('combines with other field updates in the same request', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 1 }, error: null });

    const res = await PATCH(patchRequest({ forceLogout: true, adminLabel: 'Flagged' }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ session_epoch: 2, admin_label: 'Flagged' })
    );
  });

  it('rejects a request from a disallowed origin before touching the database', async () => {
    const res = await PATCH(
      new NextRequest('https://example.com/api/admin/study-codes/curious-otter', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'https://evil.com' },
        body: JSON.stringify({ forceLogout: true }),
      }),
      { params: Promise.resolve({ code: 'curious-otter' }) }
    );

    expect(res.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/study-codes/[code] missing or unreachable rows', () => {
  it('404s a field update for a study code that does not exist', async () => {
    updateEqMock.mockReturnValueOnce({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });

    const res = await PATCH(patchRequest({ adminLabel: 'x' }), {
      params: Promise.resolve({ code: 'unknown-code' }),
    });

    expect(res.status).toBe(404);
  });

  it('answers 503, not 404, when the database errors while looking up the code for forceLogout', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await PATCH(patchRequest({ forceLogout: true }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(503);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
