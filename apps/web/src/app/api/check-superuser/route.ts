import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('check-superuser');

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 30 };

/**
 * Check whether the current session's study code is a superuser.
 * Identity comes only from the session cookie — a studyCodeId query
 * parameter, if present, is not read.
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`check-superuser:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ isSuperuser: false, wrongAnswerCountdown: null });
  }

  try {
    const { data, error } = await supabaseAdmin!
      .from('study_codes')
      .select('is_superuser, wrong_answer_countdown')
      .eq('id', session.studyCodeId)
      .single();

    if (error || !data) {
      return NextResponse.json({ isSuperuser: false, wrongAnswerCountdown: null });
    }

    return NextResponse.json({
      isSuperuser: data.is_superuser === true,
      wrongAnswerCountdown: data.wrong_answer_countdown ?? null,
    });
  } catch (error) {
    logger.error('Error checking superuser status', supabaseErrorFields(error));
    return NextResponse.json({ isSuperuser: false });
  }
}
