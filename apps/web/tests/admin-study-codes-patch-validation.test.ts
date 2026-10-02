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

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/admin/study-codes/curious-otter', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  updateEqMock.mockClear();
  updateMock.mockClear();
  fromMock.mockClear();
});

describe('PATCH /api/admin/study-codes/[code] input validation', () => {
  it('rejects a non-string adminLabel with 400 before touching the database', async () => {
    const res = await PATCH(patchRequest({ adminLabel: 12345 }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a negative wrongAnswerCountdown with 400', async () => {
    const res = await PATCH(patchRequest({ wrongAnswerCountdown: -5 }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('accepts a null wrongAnswerCountdown as a reset to the global default', async () => {
    const res = await PATCH(patchRequest({ wrongAnswerCountdown: null }), {
      params: Promise.resolve({ code: 'curious-otter' }),
    });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ wrong_answer_countdown: null }));
  });
});
