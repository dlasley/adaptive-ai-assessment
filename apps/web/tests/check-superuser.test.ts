import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { singleMock, eqMock, fromMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const fromMock = vi.fn(() => ({ select: vi.fn(() => ({ eq: eqMock })) }));
  return { singleMock, eqMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

const { requireStudentSessionMock } = vi.hoisted(() => ({
  requireStudentSessionMock: vi.fn(),
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: requireStudentSessionMock,
}));

import { GET } from '@/app/api/check-superuser/route';

beforeEach(() => {
  singleMock.mockReset();
  eqMock.mockClear();
  fromMock.mockClear();
  requireStudentSessionMock.mockReset();
});

describe('GET /api/check-superuser', () => {
  it('401s without a session, without querying the database', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await GET(
      new NextRequest('https://example.com/api/check-superuser?studyCodeId=other-id')
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('resolves identity from the session, ignoring a studyCodeId query param for a different id', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-id' });
    singleMock.mockResolvedValue({ data: { is_superuser: true, wrong_answer_countdown: null }, error: null });

    const res = await GET(
      new NextRequest('https://example.com/api/check-superuser?studyCodeId=other-id')
    );

    expect(res.status).toBe(200);
    expect(eqMock).toHaveBeenCalledWith('id', 'session-id');
    expect(eqMock).not.toHaveBeenCalledWith('id', 'other-id');
  });
});

describe('GET /api/check-superuser rate limit', () => {
  const call = () => GET(new NextRequest('https://example.com/api/check-superuser'));

  it('limits each session to 30 requests a minute, and another session is unaffected', async () => {
    singleMock.mockResolvedValue({ data: { is_superuser: false, wrong_answer_countdown: null }, error: null });
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'busy-session' });

    for (let i = 0; i < 30; i++) expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();

    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'other-session' });
    expect((await call()).status).toBe(200);
  });

  it('does not count a request that fails authentication', async () => {
    requireStudentSessionMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));

    for (let i = 0; i < 40; i++) expect((await call()).status).toBe(401);
  });
});
