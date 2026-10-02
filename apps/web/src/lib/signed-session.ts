/**
 * Generic HMAC-signed session token: sign a JSON payload, verify it back.
 * Shared by admin and student sessions so there is one signing
 * implementation, parameterized by secret and payload shape, not two.
 */

import 'server-only';
import crypto from 'crypto';

const MIN_SECRET_BYTES = 32;

export function requireSecret(envVarName: string): string {
  const secret = process.env[envVarName];
  if (!secret) throw new Error(`${envVarName} not configured`);
  if (Buffer.byteLength(secret) < MIN_SECRET_BYTES) {
    throw new Error(`${envVarName} must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return secret;
}

export function signPayload<T>(payload: T, secret: string): string {
  const data = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ data, hmac })).toString('base64');
}

/**
 * Verifies the HMAC signature and returns the decoded payload.
 * Does not check any expiry field — callers with a time-bounded payload
 * shape check that themselves after this returns.
 */
export function verifyPayload<T>(token: string, secret: string): T | null {
  try {
    const { data, hmac } = JSON.parse(Buffer.from(token, 'base64').toString());
    const expectedHmac = crypto.createHmac('sha256', secret).update(data).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
      return null;
    }

    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
