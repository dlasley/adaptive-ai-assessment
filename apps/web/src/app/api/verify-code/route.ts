import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { checkRateLimit, getClientIp, getRateLimitStore } from '@/lib/rate-limiter';
import { verifyCsrfProtection } from '@/lib/csrf';
import { createStudentSessionCookie, createStudentSessionToken } from '@/lib/student-session';
import {
  codeLockRetryAfterSeconds,
  ipLockRetryAfterSeconds,
  isInTightenedMode,
  recordCodeLookupFailure,
  recordGlobalLookupFailure,
  recordIpMiss,
  tightenedModeRetryAfterSeconds,
} from '@/lib/verify-code-guard';
import { isTurnstileConfigured, verifyTurnstileToken } from '@/lib/turnstile';
import { isProductionMode } from '@/lib/environment';
import type {
  NativeVerifyCodeResponse,
  VerifyCodeChallengeResponse,
  VerifyCodeResponse,
} from '@adaptive/shared/api-contracts';
import { verifyCodeSchema } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { isNoRowsError, supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('verify-code');

// Sized for a classroom behind one NAT: every page load with "remember me" is a lookup. Guesses are
// held to a much smaller budget by the per-IP miss lock in verify-code-guard.
const RATE_LIMIT = { windowMs: 60_000, maxRequests: 60 };

function tooManyAttempts(message: string, retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

/**
 * Verify that a study code exists and return its details.
 * Rate limited to prevent brute-force enumeration of valid codes.
 */
export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  // The circuit breaker's only production response is a Turnstile challenge, so a production-mode
  // server without Turnstile keys refuses to answer rather than run without that control.
  if (isProductionMode() && !isTurnstileConfigured()) {
    logger.error('Turnstile is not configured; verify-code is refusing requests in production');
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  const ip = getClientIp(request);
  const rl = await checkRateLimit(`verify-code:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return tooManyAttempts(
      'Too many requests. Please try again later.',
      Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
    );
  }

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  // Reaching this point means checkRateLimit found a store (its fail-closed policy would otherwise
  // have already returned above), so the store is always available here.
  const store = getRateLimitStore()!;

  const ipLockSeconds = await ipLockRetryAfterSeconds(store, ip);
  if (ipLockSeconds !== null) {
    return tooManyAttempts('Too many incorrect codes. Please try again later.', ipLockSeconds);
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
  const { turnstileToken, platform } = parsed.data;

  const code = parsed.data.code?.trim().toLowerCase();
  if (!code) {
    return NextResponse.json({ error: 'Code is required' }, { status: 400 });
  }

  const codeLockSeconds = await codeLockRetryAfterSeconds(store, code);
  if (codeLockSeconds !== null) {
    return tooManyAttempts('Too many attempts for this code. Please try again later.', codeLockSeconds);
  }

  if (await isInTightenedMode(store)) {
    if (isTurnstileConfigured()) {
      const result = await verifyTurnstileToken(turnstileToken, ip);
      if (!result.success) {
        logger.warn('Turnstile verification failed', { reason: result.reason, platform: platform ?? 'web' });
        return NextResponse.json<VerifyCodeChallengeResponse>(
          {
            error: 'Verification required',
            turnstileRequired: true,
            turnstileSiteKey: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
          },
          // Retry-After tells a client that sent no token how long until the breaker resets and a
          // plain retry can succeed. A client whose token failed needs a fresh token, not a wait.
          {
            status: 403,
            headers: turnstileToken
              ? undefined
              : { 'Retry-After': String(await tightenedModeRetryAfterSeconds(store)) },
          },
        );
      }
    } else {
      // Only reachable outside production, where Turnstile is optional: deny until the failure
      // window ends, so the breaker caps how many guesses get through instead of slowing them.
      return tooManyAttempts(
        'Too many incorrect codes across the site. Please try again later.',
        await tightenedModeRetryAfterSeconds(store),
      );
    }
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('id, code, display_name, created_at, total_quizzes, total_questions, correct_answers, session_epoch')
      .eq('code', code)
      .single();

    if (error && !isNoRowsError(error)) {
      // The database could not answer; that says nothing about the code, so it is not counted as a failed guess.
      logger.error('verify-code lookup failed', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }

    if (!data) {
      await recordCodeLookupFailure(store, code);
      await recordGlobalLookupFailure(store);
      await recordIpMiss(store, ip);
      return NextResponse.json<VerifyCodeResponse>({ exists: false });
    }

    // session_epoch is internal-only: used to mint the session, never echoed
    // back to the client, matching the exclusion discipline already applied
    // to admin_label/is_superuser/wrong_answer_countdown.
    const { session_epoch: sessionEpoch, ...details } = data;

    if (platform === 'native') {
      // The body carries a credential, so no cache may ever store it.
      return NextResponse.json<NativeVerifyCodeResponse>(
        { exists: true, details, token: createStudentSessionToken(data.id, sessionEpoch) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const response = NextResponse.json<VerifyCodeResponse>({ exists: true, details });
    const cookie = createStudentSessionCookie(data.id, sessionEpoch);
    response.cookies.set(cookie.name, cookie.value, cookie.options as Parameters<typeof response.cookies.set>[2]);
    return response;
  } catch (error) {
    logger.error('verify-code error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
