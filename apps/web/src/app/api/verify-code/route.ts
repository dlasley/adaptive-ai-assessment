import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { checkRateLimit, getClientIp, getRateLimitStore } from '@/lib/rate-limiter';
import { verifyCsrfProtection } from '@/lib/csrf';
import { createStudentSessionCookie } from '@/lib/student-session';
import {
  isCodeLockedOut,
  isInTightenedMode,
  recordCodeLookupFailure,
  recordGlobalLookupFailure,
  TIGHTENED_MODE_DELAY_MS,
} from '@/lib/verify-code-guard';
import { isTurnstileConfigured, verifyTurnstileToken } from '@/lib/turnstile';
import { verifyCodeSchema } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('verify-code');

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

/**
 * Verify that a study code exists and return its details.
 * Rate limited to prevent brute-force enumeration of valid codes.
 */
export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`verify-code:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = verifyCodeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const turnstileToken = parsed.data.turnstileToken;

  const code = parsed.data.code?.trim().toLowerCase();
  if (!code) {
    return NextResponse.json({ error: 'Code is required' }, { status: 400 });
  }

  const store = getRateLimitStore();
  if (!store) {
    // checkRateLimit above would already have failed closed in this
    // scenario (no durable store in production); this is unreachable in
    // practice, kept only so the lockout helpers below get a non-null store.
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429 },
    );
  }

  if (await isCodeLockedOut(store, code)) {
    return NextResponse.json(
      { error: 'Too many attempts for this code. Please try again later.' },
      { status: 429 },
    );
  }

  if (await isInTightenedMode(store)) {
    if (isTurnstileConfigured()) {
      const result = await verifyTurnstileToken(turnstileToken, ip);
      if (!result.success) {
        logger.warn('Turnstile verification failed', { reason: result.reason });
        return NextResponse.json(
          {
            error: 'Verification required',
            turnstileRequired: true,
            turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
          },
          { status: 403 },
        );
      }
    } else {
      // No Turnstile site key provisioned: a fixed delay is the minimum
      // circuit-breaker response, raising a scan's wall-clock cost with no
      // external dependency.
      await new Promise((resolve) => setTimeout(resolve, TIGHTENED_MODE_DELAY_MS));
    }
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('id, code, display_name, created_at, total_quizzes, total_questions, correct_answers, session_epoch')
      .eq('code', code)
      .single();

    if (error || !data) {
      await recordCodeLookupFailure(store, code);
      await recordGlobalLookupFailure(store);
      return NextResponse.json({ exists: false });
    }

    // session_epoch is internal-only: used to mint the cookie, never echoed
    // back to the client, matching the exclusion discipline already applied
    // to admin_label/is_superuser/wrong_answer_countdown.
    const { session_epoch: sessionEpoch, ...details } = data;

    const response = NextResponse.json({ exists: true, details });
    const cookie = createStudentSessionCookie(data.id, sessionEpoch);
    response.cookies.set(cookie.name, cookie.value, cookie.options as Parameters<typeof response.cookies.set>[2]);
    return response;
  } catch (error) {
    logger.error('verify-code error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
