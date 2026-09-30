/**
 * Server-side student session — HMAC-signed cookie identifying a study code.
 * Mirrors admin-session.ts's pattern via the shared signed-session helper.
 */

import 'server-only';
import { requireSecret, signPayload, verifyPayload } from './signed-session';

const COOKIE_NAME = 'student_session';
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getSecret(): string {
  return requireSecret('STUDENT_SESSION_SECRET');
}

export interface StudentSessionPayload {
  studyCodeId: string;
  sessionEpoch: number;
  issuedAt: number;
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

/**
 * Mints/refreshes the student session cookie for a study code. Called from
 * verify-code and generate-code on every successful credential exchange.
 */
export function createStudentSessionCookie(
  studyCodeId: string,
  sessionEpoch: number
): { name: string; value: string; options: Record<string, unknown> } {
  const now = Date.now();
  const payload: StudentSessionPayload = {
    studyCodeId,
    sessionEpoch,
    issuedAt: now,
    expiresAt: now + SESSION_DURATION_MS,
  };

  return {
    name: COOKIE_NAME,
    value: signPayload(payload, getSecret()),
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
