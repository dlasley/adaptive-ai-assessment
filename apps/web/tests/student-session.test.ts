import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearedStudentSessionCookie,
  createStudentSessionCookie,
  getStudentCookieName,
  verifyStudentSessionToken,
} from '@/lib/student-session';

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
  vi.useRealTimers();
});

function tamperField(token: string, field: string, value: unknown): string {
  const outer = JSON.parse(Buffer.from(token, 'base64').toString());
  const data = JSON.parse(outer.data);
  data[field] = value;
  outer.data = JSON.stringify(data);
  return Buffer.from(JSON.stringify(outer)).toString('base64');
}

describe('createStudentSessionCookie / verifyStudentSessionToken', () => {
  it('round-trips a validly signed session', () => {
    const cookie = createStudentSessionCookie('study-code-id', 3);
    const payload = verifyStudentSessionToken(cookie.value);

    expect(payload).not.toBeNull();
    expect(payload?.studyCodeId).toBe('study-code-id');
    expect(payload?.sessionEpoch).toBe(3);
  });

  it('rejects a missing token', () => {
    expect(verifyStudentSessionToken(undefined)).toBeNull();
  });

  it('rejects an expired token', () => {
    vi.useFakeTimers();
    const cookie = createStudentSessionCookie('study-code-id', 1);
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);

    expect(verifyStudentSessionToken(cookie.value)).toBeNull();
  });

  it.each([
    ['studyCodeId', 'a-different-study-code-id'],
    ['sessionEpoch', 999],
    ['expiresAt', Date.now() + 365 * 24 * 60 * 60 * 1000],
  ])('rejects a token with %s tampered', (field, value) => {
    const cookie = createStudentSessionCookie('study-code-id', 1);
    const tampered = tamperField(cookie.value, field, value);

    expect(verifyStudentSessionToken(tampered)).toBeNull();
  });

  it('throws when the secret is shorter than 32 bytes', () => {
    process.env.STUDENT_SESSION_SECRET = 'secret';
    expect(() => createStudentSessionCookie('study-code-id', 1)).toThrow(/at least 32 bytes/);
  });

  it('accepts a secret of exactly 32 bytes', () => {
    process.env.STUDENT_SESSION_SECRET = 'a'.repeat(32);
    expect(() => createStudentSessionCookie('study-code-id', 1)).not.toThrow();
  });

  it('throws loudly when STUDENT_SESSION_SECRET is unset', () => {
    delete process.env.STUDENT_SESSION_SECRET;
    expect(() => createStudentSessionCookie('study-code-id', 1)).toThrow();
  });
});

describe('clearedStudentSessionCookie', () => {
  it('clears the same cookie name with maxAge 0', () => {
    const cookie = clearedStudentSessionCookie();
    expect(cookie.name).toBe(getStudentCookieName());
    expect(cookie.options.maxAge).toBe(0);
  });
});
