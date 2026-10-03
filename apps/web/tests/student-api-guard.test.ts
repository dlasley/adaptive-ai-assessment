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
import { createStudentSessionCookie, createStudentSessionToken, getStudentCookieName } from '@/lib/student-session';

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) {
    headers.set('cookie', `${getStudentCookieName()}=${cookieValue}`);
  }
  return new NextRequest('https://example.com/api/student/dashboard', { headers });
}

function requestWith(headers: { authorization?: string; cookieValue?: string }): NextRequest {
  const result = new Headers();
  if (headers.authorization !== undefined) result.set('authorization', headers.authorization);
  if (headers.cookieValue) result.set('cookie', `${getStudentCookieName()}=${headers.cookieValue}`);
  return new NextRequest('https://example.com/api/student/dashboard', { headers: result });
}

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
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

describe('requireStudentSession with a bearer token', () => {
  it('accepts a valid bearer with no cookie', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 2 }, error: null });

    const result = await requireStudentSession(
      requestWith({ authorization: `Bearer ${createStudentSessionToken('bearer-id', 2)}` })
    );

    expect(result).not.toBeInstanceOf(NextResponse);
    expect((result as { studyCodeId: string }).studyCodeId).toBe('bearer-id');
    expect(eqMock).toHaveBeenCalledWith('id', 'bearer-id');
  });

  it('rejects a garbage bearer even with a valid cookie, without querying the database', async () => {
    const result = await requireStudentSession(
      requestWith({ authorization: 'Bearer garbage', cookieValue: createStudentSessionToken('cookie-id', 1) })
    );

    expect((result as NextResponse).status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization scheme even with a valid cookie', async () => {
    const result = await requireStudentSession(
      requestWith({ authorization: 'Basic dXNlcjpwYXNz', cookieValue: createStudentSessionToken('cookie-id', 1) })
    );

    expect((result as NextResponse).status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a valid session token sent under the Basic scheme', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 1 }, error: null });

    const result = await requireStudentSession(
      requestWith({ authorization: `Basic ${createStudentSessionToken('bearer-id', 1)}` })
    );

    expect((result as NextResponse).status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('rejects a bearer minted at epoch 2 once the live row is at epoch 5', async () => {
    singleMock.mockResolvedValue({ data: { session_epoch: 5 }, error: null });

    const result = await requireStudentSession(
      requestWith({ authorization: `Bearer ${createStudentSessionToken('bearer-id', 2)}` })
    );

    expect((result as NextResponse).status).toBe(401);
  });

  it('rejects a bearer signed with a different secret', async () => {
    process.env.STUDENT_SESSION_SECRET = 'another-student-secret-0123456789abcdef0123';
    const foreign = createStudentSessionToken('bearer-id', 1);
    process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
    singleMock.mockResolvedValue({ data: { session_epoch: 1 }, error: null });

    const result = await requireStudentSession(requestWith({ authorization: `Bearer ${foreign}` }));

    expect((result as NextResponse).status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });
});
