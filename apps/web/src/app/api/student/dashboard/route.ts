import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { createLogger } from '@/lib/logger';
import { isNoRowsError, supabaseErrorFields } from '@/lib/supabase-error';

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

  try {
    const { data: studyCode, error: studyCodeError } = await supabaseAdmin!
      .from('study_codes')
      .select('code, display_name, created_at, total_quizzes, total_questions, correct_answers')
      .eq('id', session.studyCodeId)
      .single();

    if (studyCodeError && !isNoRowsError(studyCodeError)) {
      logger.error('Error fetching study code', supabaseErrorFields(studyCodeError));
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }

    if (!studyCode) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const [quizHistory, conceptMastery, weakTopics] = await Promise.all([
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

    const failedRead = [quizHistory, conceptMastery, weakTopics].find((result) => result.error);
    if (failedRead) {
      logger.error('Error fetching dashboard data', supabaseErrorFields(failedRead.error));
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }

    return NextResponse.json({
      profile: {
        code: studyCode.code,
        displayName: studyCode.display_name,
        createdAt: studyCode.created_at,
        totalQuizzes: studyCode.total_quizzes,
        totalQuestions: studyCode.total_questions,
        correctAnswers: studyCode.correct_answers,
      },
      quizHistory: quizHistory.data || [],
      conceptMastery: conceptMastery.data || [],
      weakTopics: weakTopics.data || [],
    });
  } catch (error) {
    logger.error('student/dashboard error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
