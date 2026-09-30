import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('student/dashboard');

const QUIZ_HISTORY_LIMIT = 50;

/**
 * Combines the profile, quiz history, concept mastery, and weak-topics
 * reads the progress page needs into one request, scoped to the session's
 * own study code.
 */
export async function GET(request: NextRequest) {
  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  try {
    const { data: studyCode, error: studyCodeError } = await supabaseAdmin!
      .from('study_codes')
      .select('code, display_name, created_at, total_quizzes, total_questions, correct_answers')
      .eq('id', session.studyCodeId)
      .single();

    if (studyCodeError || !studyCode) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const [{ data: quizHistory }, { data: conceptMastery }, { data: weakTopics }] = await Promise.all([
      supabaseAdmin!
        .from('quiz_history')
        .select('*')
        .eq('study_code_id', session.studyCodeId)
        .order('quiz_date', { ascending: false })
        .limit(QUIZ_HISTORY_LIMIT),
      supabaseAdmin!
        .from('concept_mastery')
        .select('*')
        .eq('study_code_id', session.studyCodeId)
        .order('mastery_percentage', { ascending: true }),
      supabaseAdmin!
        .from('weak_topics')
        .select('*')
        .eq('study_code_id', session.studyCodeId)
        .order('mastery_percentage', { ascending: true }),
    ]);

    return NextResponse.json({
      profile: {
        code: studyCode.code,
        displayName: studyCode.display_name,
        createdAt: studyCode.created_at,
        totalQuizzes: studyCode.total_quizzes,
        totalQuestions: studyCode.total_questions,
        correctAnswers: studyCode.correct_answers,
      },
      quizHistory: quizHistory || [],
      conceptMastery: conceptMastery || [],
      weakTopics: weakTopics || [],
    });
  } catch (error) {
    logger.error('student/dashboard error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
