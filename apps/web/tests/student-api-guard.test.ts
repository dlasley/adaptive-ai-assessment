import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { singleMock, eqMock, selectMock, fromMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const eqMock = vi.fn(() => ({ single: singleMock }));
  const selectMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  return { singleMock, eqMock, selectMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

import { requireStudentSession } from '@/lib/student-api-guard';
import { createStudentSessionCookie, getStudentCookieName } from '@/lib/student-session';

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) {
    headers.set('cookie', `${getStudentCookieName()}=${cookieValue}`);
  }
  return new NextRequest('https://example.com/api/student/dashboard', { headers });
}

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-secret';
  singleMock.mockReset();
  eqMock.mockClear();
  selectMock.mockClear();
  fromMock.mockClear();
});

describe('requireStudentSession', () => {
  it('rejects a request with no session cookie, without querying the database', async () => {
    const result = await requireStudentSession(requestWithCookie());

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('accepts a valid session whose sessionEpoch matches the live row', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 2 }, error: null });
    const cookie = createStudentSessionCookie('study-id', 2);

    const result = await requireStudentSession(requestWithCookie(cookie.value));

    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { studyCodeId: string }).studyCodeId).toBe('study-id');
  });

  it('rejects a session once the live session_epoch no longer matches (revoked)', async () => {
    // Cookie was minted at epoch 2; the live row has since moved to epoch 5
    // (e.g. an admin forceLogout) — signature and expiry are both still
    // valid, only the epoch comparison should reject this.
    singleMock.mockResolvedValue({ data: { session_epoch: 5 }, error: null });
    const cookie = createStudentSessionCookie('study-id', 2);

    const result = await requireStudentSession(requestWithCookie(cookie.value));

    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it('rejects with 401 when the study_codes row cannot be found', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    const cookie = createStudentSessionCookie('study-id', 1);

    const result = await requireStudentSession(requestWithCookie(cookie.value));

    expect((result as NextResponse).status).toBe(401);
  });

  it('answers 503, not 401, when the database errors, so a blip does not sign the student out', async () => {
    singleMock.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cookie = createStudentSessionCookie('study-id', 1);

    const result = await requireStudentSession(requestWithCookie(cookie.value));

    expect((result as NextResponse).status).toBe(503);
  });
});
