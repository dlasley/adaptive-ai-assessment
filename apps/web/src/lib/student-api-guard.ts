/**
 * Reusable student-session auth check for API routes.
 * Async (unlike admin-route-guard's requireAdmin) because it also compares
 * the session's embedded sessionEpoch against the live study_codes row —
 * a mismatch means the session was revoked (e.g. an admin forceLogout)
 * and must be rejected exactly like an invalid signature.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readStudentSessionToken, verifyStudentSessionToken } from './student-session';
import { supabaseAdmin, isSupabaseAdminAvailable } from './supabase-admin';
import { isNoRowsError, supabaseErrorFields } from './supabase-error';
import { createLogger } from './logger';

const logger = createLogger('student-api-guard');

export interface StudentSession {
  studyCodeId: string;
}

export async function requireStudentSession(
  request: NextRequest
): Promise<StudentSession | NextResponse> {
  const token = readStudentSessionToken(request);
  const payload = verifyStudentSessionToken(token);
  if (!payload) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  const { data, error } = await supabaseAdmin!
    .from('study_codes')
    .select('session_epoch')
    .eq('id', payload.studyCodeId)
    .single();

  if (error && !isNoRowsError(error)) {
    logger.error('Error checking student session', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  if (!data || data.session_epoch !== payload.sessionEpoch) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return { studyCodeId: payload.studyCodeId };
}
