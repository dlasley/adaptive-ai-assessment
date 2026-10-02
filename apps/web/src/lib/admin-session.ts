/**
 * Server-side admin session handling: verifies the shared admin password and signs/verifies the
 * HMAC-signed session cookie. `admin-route-guard.ts` calls `verifySessionFromCookie()` per request
 * to gate an API route; this file owns cookie creation/verification only, not the per-request
 * check itself.
 */

import 'server-only';
import crypto from 'crypto';
import { requireSecret, signPayload, verifyPayload } from './signed-session';
import { createLogger } from './logger';

const logger = createLogger('admin-session');

const COOKIE_NAME = 'admin_session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSecret(): string {
  return requireSecret('ADMIN_SESSION_SECRET');
}

interface SessionPayload {
  authenticated: boolean;
  expiresAt: number;
}

function sign(payload: SessionPayload): string {
  return signPayload(payload, getSecret());
}

function verify(token: string): SessionPayload | null {
  const payload = verifyPayload<SessionPayload>(token, getSecret());
  if (!payload) return null;
  if (Date.now() > payload.expiresAt) return null;
  return payload;
}

export const ADMIN_PASSWORD_MIN_LENGTH = 16;

let loggedShortPassword = false;

export function verifyAdminPassword(password: string): boolean {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return false;

  if (adminPassword.length < ADMIN_PASSWORD_MIN_LENGTH) {
    if (!loggedShortPassword) {
      loggedShortPassword = true;
      logger.error(`ADMIN_PASSWORD is shorter than ${ADMIN_PASSWORD_MIN_LENGTH} characters; admin login is refused`);
    }
    return false;
  }

  // Hashing both sides gives equal-length buffers, so the comparison time does not reveal the length.
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(password), digest(adminPassword));
}

export function createSessionCookie(): { name: string; value: string; options: Record<string, unknown> } {
  const payload: SessionPayload = {
    authenticated: true,
    expiresAt: Date.now() + SESSION_DURATION_MS,
  };

  return {
    name: COOKIE_NAME,
    value: sign(payload),
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: SESSION_DURATION_MS / 1000,
    },
  };
}

export function verifySessionFromCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const payload = verify(cookieValue);
  return payload?.authenticated === true;
}

export function getAdminCookieName(): string {
  return COOKIE_NAME;
}
