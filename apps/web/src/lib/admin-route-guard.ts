/**
 * Per-request admin auth check for API routes: reads the session cookie and rejects with 401 if
 * `admin-session.ts` doesn't verify it. Every `/api/admin/*` route (other than login itself) calls
 * `requireAdmin()` first.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionFromCookie, getAdminCookieName } from './admin-session';

export function requireAdmin(request: NextRequest): NextResponse | null {
  const cookieValue = request.cookies.get(getAdminCookieName())?.value;
  if (!verifySessionFromCookie(cookieValue)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
