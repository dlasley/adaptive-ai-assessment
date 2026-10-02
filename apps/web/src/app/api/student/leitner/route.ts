import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { verifyCsrfProtection } from '@/lib/csrf';
import { leitnerUpdateSchema } from '@/lib/api-schemas';
import { calculateNewBox } from '@/lib/leitner';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('student/leitner');

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = leitnerUpdateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { questionId, isCorrect } = parsed.data;
  const studyCodeId = session.studyCodeId;

  try {
    const { data: existing, error: fetchError } = await supabaseAdmin!
      .from('leitner_state')
      .select('box, consecutive_correct')
      .eq('study_code_id', studyCodeId)
      .eq('question_id', questionId)
      .maybeSingle();

    if (fetchError) {
      logger.error('Error fetching Leitner state', supabaseErrorFields(fetchError));
      return NextResponse.json({ error: 'Failed to update Leitner state' }, { status: 500 });
    }

    const { box, consecutiveCorrect } = calculateNewBox(
      (existing?.box as number) ?? 1,
      (existing?.consecutive_correct as number) ?? 0,
      isCorrect
    );

    const { error: upsertError } = await supabaseAdmin!.from('leitner_state').upsert(
      {
        study_code_id: studyCodeId,
        question_id: questionId,
        box,
        consecutive_correct: consecutiveCorrect,
        last_reviewed: new Date().toISOString(),
      },
      { onConflict: 'study_code_id,question_id' }
    );

    if (upsertError) {
      logger.error('Error updating Leitner state', supabaseErrorFields(upsertError));
      return NextResponse.json({ error: 'Failed to update Leitner state' }, { status: 500 });
    }

    return NextResponse.json({ box, consecutiveCorrect });
  } catch (error) {
    logger.error('student/leitner error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
