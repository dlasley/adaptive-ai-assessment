import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { deleteMock, inMock, selectMock, fromMock } = vi.hoisted(() => {
  const selectMock = vi.fn();
  const inMock = vi.fn(() => ({ select: selectMock }));
  const deleteMock = vi.fn(() => ({ in: inMock }));
  const fromMock = vi.fn(() => ({ delete: deleteMock }));
  return { deleteMock, inMock, selectMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/admin-route-guard', () => ({
  requireAdmin: () => null,
}));

import { POST } from '@/app/api/admin/study-codes/bulk-delete/route';

const PROD_URL = 'french-1.vercel.app';

function bulkDeleteRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/admin/study-codes/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  deleteMock.mockClear();
  inMock.mockClear();
  selectMock.mockReset();
  fromMock.mockClear();
});

describe('POST /api/admin/study-codes/bulk-delete', () => {
  it('rejects a request from a disallowed origin before touching the database', async () => {
    const res = await POST(
      bulkDeleteRequest({ codes: ['curious-otter'] }, { origin: 'https://evil.com' })
    );

    expect(res.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('deletes every matching code in a single statement', async () => {
    selectMock.mockResolvedValue({ data: [{ code: 'curious-otter' }, { code: 'happy-fox' }], error: null });

    const res = await POST(bulkDeleteRequest({ codes: ['curious-otter', 'happy-fox'] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(inMock).toHaveBeenCalledWith('code', ['curious-otter', 'happy-fox']);
    expect(body).toEqual({ success: true, deleted: 2, failed: [] });
  });

  it('reports a code that matched no row as failed, not deleted', async () => {
    // Supabase reports no error for a delete that matched zero rows — only the returned rows (via
    // .select()) distinguish "deleted" from "already gone or never existed".
    selectMock.mockResolvedValue({ data: [{ code: 'curious-otter' }], error: null });

    const res = await POST(bulkDeleteRequest({ codes: ['curious-otter', 'no-such-code'] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: false, deleted: 1, failed: ['no-such-code'] });
  });

  it('rejects an empty codes array with 400', async () => {
    const res = await POST(bulkDeleteRequest({ codes: [] }));

    expect(res.status).toBe(400);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('dedupes a repeated code before deleting and counting', async () => {
    selectMock.mockResolvedValue({ data: [{ code: 'curious-otter' }, { code: 'happy-fox' }], error: null });

    const res = await POST(bulkDeleteRequest({ codes: ['curious-otter', 'curious-otter', 'happy-fox'] }));
    const body = await res.json();

    expect(inMock).toHaveBeenCalledWith('code', ['curious-otter', 'happy-fox']);
    expect(body).toEqual({ success: true, deleted: 2, failed: [] });
  });
});

describe('POST /api/admin/study-codes/bulk-delete input validation', () => {
  it.each([
    ['a non-array', { codes: 'curious-otter' }],
    ['an empty list', { codes: [] }],
    ['a missing list', {}],
    ['non-string entries', { codes: ['curious-otter', 5] }],
    ['an empty-string entry', { codes: [''] }],
    ['an oversized entry', { codes: ['x'.repeat(201)] }],
    ['more codes than one request may carry', { codes: Array.from({ length: 501 }, (_, i) => `code-${i}`) }],
  ])('answers 400 for %s without touching the database', async (_name, body) => {
    const res = await POST(bulkDeleteRequest(body));

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('accepts a list at the cap', async () => {
    selectMock.mockResolvedValue({ data: [], error: null });

    const res = await POST(bulkDeleteRequest({ codes: Array.from({ length: 500 }, (_, i) => `code-${i}`) }));

    expect(res.status).toBe(200);
  });
});
