import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminPassword, createSessionCookie } from '@/lib/admin-session';
import { checkRateLimit, getClientIp, getRateLimitStore } from '@/lib/rate-limiter';
import {
  isAdminLoginInTightenedMode,
  recordAdminLoginFailure,
  ADMIN_LOGIN_TIGHTENED_MODE_DELAY_MS,
} from '@/lib/admin-lockout-policy';
import { verifyCsrfProtection } from '@/lib/csrf';
import { adminLoginSchema } from '@/lib/api-schemas';

const LOGIN_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 5 };

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const clientIp = getClientIp(request);
  const rateLimitResult = await checkRateLimit(`admin-login:${clientIp}`, LOGIN_RATE_LIMIT);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Too many login attempts. Please wait.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)) } }
    );
  }

  // Reaching this point means checkRateLimit found a store (its fail-closed
  // policy would otherwise have already returned above), so the store is
  // always available here.
  const store = getRateLimitStore()!;

  if (await isAdminLoginInTightenedMode(store)) {
    await new Promise((resolve) => setTimeout(resolve, ADMIN_LOGIN_TIGHTENED_MODE_DELAY_MS));
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    await recordAdminLoginFailure(store);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = adminLoginSchema.safeParse(rawBody);
  if (!parsed.success) {
    await recordAdminLoginFailure(store);
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    if (!verifyAdminPassword(parsed.data.password)) {
      await recordAdminLoginFailure(store);
      return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
    }

    const cookie = createSessionCookie();
    const response = NextResponse.json({ success: true });
    response.cookies.set(cookie.name, cookie.value, cookie.options as Parameters<typeof response.cookies.set>[2]);

    return response;
  } catch {
    return NextResponse.json({ error: 'Login failed' }, { status: 500 });
  }
}
