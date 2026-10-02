/**
 * Every other admin-study-codes route test mocks `@/lib/admin-route-guard` away (`requireAdmin: ()
 * => null`) to focus on route logic, which means none of them ever exercise the real auth gate. This
 * file is the one place that leaves `admin-route-guard` unmocked, so a missing or misordered
 * `requireAdmin()` call in a write route would actually fail a test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

import { PATCH, DELETE } from '@/app/api/admin/study-codes/[code]/route';
import { POST as bulkDelete } from '@/app/api/admin/study-codes/bulk-delete/route';

const PROD_URL = 'french-1.vercel.app';

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  process.env.ADMIN_SESSION_SECRET = 'test-admin-secret-0123456789abcdef0123456789';
  delete process.env.VERCEL_URL;
  fromMock.mockClear();
});

function requestWithoutSession(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('admin write routes without an admin session', () => {
  it('PATCH /api/admin/study-codes/[code] returns 401 and never touches the database', async () => {
    const res = await PATCH(
      requestWithoutSession('https://example.com/api/admin/study-codes/curious-otter', 'PATCH', {
        adminLabel: 'x',
      }),
      { params: Promise.resolve({ code: 'curious-otter' }) }
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('DELETE /api/admin/study-codes/[code] returns 401 and never touches the database', async () => {
    const res = await DELETE(
      requestWithoutSession('https://example.com/api/admin/study-codes/curious-otter', 'DELETE'),
      { params: Promise.resolve({ code: 'curious-otter' }) }
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('POST /api/admin/study-codes/bulk-delete returns 401 and never touches the database', async () => {
    const res = await bulkDelete(
      requestWithoutSession('https://example.com/api/admin/study-codes/bulk-delete', 'POST', {
        codes: ['curious-otter'],
      })
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
