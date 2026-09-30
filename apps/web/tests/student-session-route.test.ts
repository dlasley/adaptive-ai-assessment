import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createStudentSessionCookie, getStudentCookieName } from '@/lib/student-session';
import { GET } from '@/app/api/student/session/route';

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-secret';
});

function requestWithCookie(cookieValue?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers.cookie = `${getStudentCookieName()}=${cookieValue}`;
  }
  return new NextRequest('https://french-1.vercel.app/api/student/session', { headers });
}

describe('GET /api/student/session', () => {
  it('reports authenticated for a validly signed, unexpired cookie', async () => {
    const cookie = createStudentSessionCookie('study-code-id', 1);

    const res = await GET(requestWithCookie(cookie.value));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ authenticated: true });
  });

  it('reports unauthenticated when no cookie is present', async () => {
    const res = await GET(requestWithCookie());
    const body = await res.json();

    expect(body).toEqual({ authenticated: false });
  });

  it('reports unauthenticated for a tampered cookie', async () => {
    const cookie = createStudentSessionCookie('study-code-id', 1);
    const outer = JSON.parse(Buffer.from(cookie.value, 'base64').toString());
    const data = JSON.parse(outer.data);
    data.studyCodeId = 'a-different-study-code-id';
    outer.data = JSON.stringify(data);
    const tampered = Buffer.from(JSON.stringify(outer)).toString('base64');

    const res = await GET(requestWithCookie(tampered));
    const body = await res.json();

    expect(body).toEqual({ authenticated: false });
  });

  it('reports unauthenticated for a garbage cookie value', async () => {
    const res = await GET(requestWithCookie('not-a-real-token'));
    const body = await res.json();

    expect(body).toEqual({ authenticated: false });
  });
});
