import { NextRequest, NextResponse } from 'next/server';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';

const RATE_LIMIT = { windowMs: 60_000, maxRequests: 20 };

/**
 * Verify that a study code exists and return its details.
 * Rate limited to prevent brute-force enumeration of valid codes.
 */
export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const rl = checkRateLimit(`verify-code:${ip}`, RATE_LIMIT);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
    );
  }

  if (!isSupabaseAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const code = body.code?.trim().toLowerCase();
  if (!code) {
    return NextResponse.json({ error: 'Code is required' }, { status: 400 });
  }

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('id, code, display_name, created_at, total_quizzes, total_questions, correct_answers')
      .eq('code', code)
      .single();

    if (error || !data) {
      return NextResponse.json({ exists: false });
    }

    return NextResponse.json({
      exists: true,
      details: data,
    });
  } catch (error) {
    console.error('verify-code error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
