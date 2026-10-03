import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { checkRateLimit } from '@/lib/rate-limiter';
import { tooManyRequestsResponse } from '@/lib/rate-limit-response';
import { createLogger } from '@/lib/logger';
import { isNoRowsError, supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('check-superuser');

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

/**
 * Check whether the current session's study code is a superuser.
 * Identity comes only from the session (cookie or bearer token); a studyCodeId query
 * parameter, if present, is not read.
 */
export async function GET(request: NextRequest) {
  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  const rl = await checkRateLimit(`check-superuser:${session.studyCodeId}`, RATE_LIMIT);
  if (!rl.allowed) return tooManyRequestsResponse('Too many requests. Please try again later.', rl.resetAt);

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('is_superuser, wrong_answer_countdown')
      .eq('id', session.studyCodeId)
      .single();

    if (error && !isNoRowsError(error)) {
      logger.error('Error checking superuser status', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }

    if (!data) {
      return NextResponse.json({ isSuperuser: false, wrongAnswerCountdown: null });
    }

    return NextResponse.json({
      isSuperuser: data.is_superuser === true,
      wrongAnswerCountdown: data.wrong_answer_countdown ?? null,
    });
  } catch (error) {
    logger.error('Error checking superuser status', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to check superuser status' }, { status: 500 });
  }
}
