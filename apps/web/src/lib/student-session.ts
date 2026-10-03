/**
 * Server-side student session: an HMAC-signed token identifying a study code. The web client
 * carries it in an httpOnly cookie; a native client carries the same token as an
 * `Authorization: Bearer` header. Mirrors admin-session.ts's pattern via the shared signed-session
 * helper. This is the only module that names the student cookie.
 */

import 'server-only';
import type { NextRequest } from 'next/server';
import { requireSecret, signPayload, verifyPayload } from './signed-session';

const COOKIE_NAME = 'student_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  return requireSecret('STUDENT_SESSION_SECRET');
}

export interface StudentSessionPayload {
  studyCodeId: string;
  sessionEpoch: number;
  expiresAt: number;
}

function baseCookieOptions(): Record<string, unknown> {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** Signs a fresh session for a study code; the value carried by both the cookie and a bearer header. */
export function createStudentSessionToken(studyCodeId: string, sessionEpoch: number): string {
  const payload: StudentSessionPayload = {
    studyCodeId,
    sessionEpoch,
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };
  return signPayload(payload, getSecret());
}

/**
 * Mints/refreshes the student session cookie for a study code. Called from
 * verify-code and generate-code on every successful credential exchange.
 */
export function createStudentSessionCookie(
  studyCodeId: string,
  sessionEpoch: number
): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: COOKIE_NAME,
    value: createStudentSessionToken(studyCodeId, sessionEpoch),
    options: {
      ...baseCookieOptions(),
      maxAge: SESSION_DURATION_MS / 1000,
    },
  };
}

/**
 * Verifies signature, shape, and expiry only. Does not check session_epoch
 * against the live database row — that is requireStudentSession's job,
 * since it needs a DB round trip this pure function shouldn't perform.
 */
export function verifyStudentSessionToken(token: string | undefined): StudentSessionPayload | null {
  if (!token) return null;

  const payload = verifyPayload<StudentSessionPayload>(token, getSecret());
  if (!payload) return null;

  if (
    typeof payload.studyCodeId !== 'string' ||
    typeof payload.sessionEpoch !== 'number' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return null;
  }

  if (Date.now() > payload.expiresAt) return null;

  return payload;
}

export function getStudentCookieName(): string {
  return COOKIE_NAME;
}

const BEARER_PATTERN = /^Bearer +(\S+)$/i;

/**
 * Returns the unverified session token a request carries. An Authorization header, when present,
 * is the only credential considered: a Bearer value is returned as is (so an invalid one fails
 * verification rather than falling through to the cookie), and any other scheme or a malformed
 * value yields no token. Without an Authorization header the cookie is read.
 */
export function readStudentSessionToken(request: NextRequest): string | undefined {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    return BEARER_PATTERN.exec(authorization.trim())?.[1];
  }
  return request.cookies.get(COOKIE_NAME)?.value;
}

export function clearedStudentSessionCookie(): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: COOKIE_NAME,
    value: '',
    options: {
      ...baseCookieOptions(),
      maxAge: 0,
    },
  };
}
