/**
 * CSRF defense for state-changing routes: an Origin/Referer allow-list
 * plus strict Content-Type enforcement. Call this before parsing the
 * request body — it never reads the body itself, so a rejected request
 * costs nothing beyond the header checks.
 *
 * SameSite=Lax on a session cookie protects requests that carry an
 * existing cookie; it does nothing to stop a cross-site request from
 * triggering a route that *mints* a new cookie (login CSRF). This closes
 * that gap for the two routes that mint sessions, and for every other
 * state-changing route as defense-in-depth.
 */

import { NextRequest, NextResponse } from 'next/server';

function getAllowedOrigins(): string[] {
  const origins: string[] = [];
  if (process.env.VERCEL_URL) origins.push(`https://${process.env.VERCEL_URL}`);
  // The branch alias (git-<branch>-...) that follows a branch's latest preview or production deploy.
  if (process.env.VERCEL_BRANCH_URL) origins.push(`https://${process.env.VERCEL_BRANCH_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    origins.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.NODE_ENV !== 'production') origins.push('http://localhost:3000');
  return origins;
}

/** Parses a header value to a structured origin. Never substring/prefix-match the raw string. */
function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function verifyCsrfProtection(request: NextRequest): NextResponse | null {
  const contentType = request.headers.get('content-type');
  if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 });
  }

  const allowedOrigins = getAllowedOrigins();

  const originHeader = request.headers.get('origin');
  const refererHeader = request.headers.get('referer');
  const candidate = originHeader ?? refererHeader;

  if (candidate) {
    const origin = parseOrigin(candidate);
    if (origin && allowedOrigins.includes(origin)) {
      return null;
    }
  }

  return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
}
