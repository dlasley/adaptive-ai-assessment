import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-route-guard';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { verifyCsrfProtection } from '@/lib/csrf';
import { dbToStudyCodeSummary } from '@/lib/study-code-mapper';
import { studyCodePatchSchema } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('admin/study-codes/[code]');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  const { code } = await params;

  try {
    const { data: studyCodeData } = await supabaseAdmin!
      .from('study_codes')
      .select('*')
      .eq('code', code)
      .single();

    if (!studyCodeData) {
      return NextResponse.json({ error: 'Study code not found' }, { status: 404 });
    }

    const studyCode = dbToStudyCodeSummary(studyCodeData);

    const { data: quizHistory } = await supabaseAdmin!
      .from('quiz_history')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('quiz_date', { ascending: false });

    const { data: conceptMastery } = await supabaseAdmin!
      .from('concept_mastery')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: false });

    const { data: weakTopics } = await supabaseAdmin!
      .from('weak_topics')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: true });

    return NextResponse.json({
      studyCode,
      quizHistory: quizHistory || [],
      conceptMastery: conceptMastery || [],
      weakTopics: weakTopics || [],
    });
  } catch (error) {
    logger.error('Error fetching study code progress', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to fetch study code progress' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  const { code } = await params;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = studyCodePatchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const body = parsed.data;

  try {
    const updates: Record<string, unknown> = {};

    if (body.adminLabel !== undefined) updates.admin_label = body.adminLabel;
    if (body.wrongAnswerCountdown !== undefined) updates.wrong_answer_countdown = body.wrongAnswerCountdown;

    if (body.forceLogout === true) {
      // Bumping session_epoch invalidates every active student_session
      // cookie for this study code immediately, regardless of expiry — the
      // lost/stolen-device revocation path.
      const { data: current, error: fetchError } = await supabaseAdmin!
        .from('study_codes')
        .select('session_epoch')
        .eq('code', code)
        .single();

      if (fetchError || !current) {
        return NextResponse.json({ error: 'Study code not found' }, { status: 404 });
      }

      updates.session_epoch = current.session_epoch + 1;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const { error } = await supabaseAdmin!
      .from('study_codes')
      .update(updates)
      .eq('code', code);

    if (error) {
      logger.error('Error updating study code', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Failed to update study code' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Error updating study code', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to update study code' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const authError = requireAdmin(request);
  if (authError) return authError;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  const { code } = await params;

  try {
    const { error } = await supabaseAdmin!
      .from('study_codes')
      .delete()
      .eq('code', code);

    if (error) {
      logger.error('Error deleting study code', supabaseErrorFields(error));
      return NextResponse.json({ error: 'Failed to delete study code' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Error deleting study code', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Failed to delete study code' }, { status: 500 });
  }
}
