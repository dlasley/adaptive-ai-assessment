import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, isSupabaseAdminAvailable } from '@/lib/supabase-admin';
import { loadQuestionsByIds } from '@/lib/question-loader';
import { requireStudentSession } from '@/lib/student-api-guard';
import { verifyCsrfProtection } from '@/lib/csrf';
import { quizResultsSchema } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('student/quiz-results');

async function updateStudyCodeStats(studyCodeId: string): Promise<void> {
  const { data: resultsData, error: resultsError } = await supabaseAdmin!
    .from('question_results')
    .select('is_correct')
    .eq('study_code_id', studyCodeId);

  if (resultsError || !resultsData) {
    logger.error('Error getting stats', supabaseErrorFields(resultsError));
    return;
  }

  const totalQuestions = resultsData.length;
  const correctAnswers = resultsData.filter((r) => r.is_correct).length;

  const { data: quizData, error: quizError } = await supabaseAdmin!
    .from('quiz_history')
    .select('id', { count: 'exact' })
    .eq('study_code_id', studyCodeId);

  if (quizError) {
    logger.error('Error getting quiz count', supabaseErrorFields(quizError));
    return;
  }

  const totalQuizzes = quizData?.length || 0;

  await supabaseAdmin!
    .from('study_codes')
    .update({
      total_quizzes: totalQuizzes,
      total_questions: totalQuestions,
      correct_answers: correctAnswers,
    })
    .eq('id', studyCodeId);
}

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  if (!isSupabaseAdminAvailable()) {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const parsed = quizResultsSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const result = parsed.data;
  const studyCodeId = session.studyCodeId;

  try {
    const { data: quizData, error: quizError } = await supabaseAdmin!
      .from('quiz_history')
      .insert({
        study_code_id: studyCodeId,
        unit_id: result.unitId,
        difficulty: result.difficulty,
        total_questions: result.totalQuestions,
        correct_answers: result.correctAnswers,
        score_percentage: result.scorePercentage,
        time_spent_seconds: result.timeSpentSeconds ?? null,
      })
      .select()
      .single();

    if (quizError || !quizData) {
      logger.error('Error saving quiz history', supabaseErrorFields(quizError));
      return NextResponse.json({ error: 'Failed to save quiz results' }, { status: 500 });
    }

    const quizHistoryId = quizData.id;

    // The stored correct_answer, and the is_correct comparison derived from it, come from the
    // questions table rather than the client — a client-supplied correctAnswer could otherwise
    // be set equal to the client's own userAnswer to force a 100%-correct result.
    const dbQuestions = await loadQuestionsByIds(result.questions.map((q) => q.id));

    const questionResults = result.questions
      .map((question) => {
        const dbQuestion = dbQuestions.get(question.id);
        if (!dbQuestion) {
          logger.warn('Skipping quiz-results row for unknown question id', { questionId: question.id });
          return null;
        }

        const evalResult = result.evaluationResults?.[question.id];
        const isCorrect = evalResult
          ? evalResult.isCorrect
          : result.userAnswers[question.id] === dbQuestion.correctAnswer;

        return {
          quiz_history_id: quizHistoryId,
          study_code_id: studyCodeId,
          question_id: question.id,
          topic: question.topic,
          difficulty: question.difficulty,
          is_correct: isCorrect,
          user_answer: result.userAnswers[question.id] || null,
          correct_answer: dbQuestion.correctAnswer,
          score: evalResult?.score ?? (isCorrect ? 100 : 0),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (questionResults.length > 0) {
      const { error: resultsError } = await supabaseAdmin!
        .from('question_results')
        .insert(questionResults);

      if (resultsError) {
        // question_results.user_answer is student free-text; supabaseErrorFields keeps this out
        // of `details`, which Postgres documents as embedding full failing-row column values.
        logger.error('Error saving question results', supabaseErrorFields(resultsError));
        // Quiz history is already saved; still return its ID.
      }
    }

    await updateStudyCodeStats(studyCodeId);

    return NextResponse.json({ quizHistoryId });
  } catch (error) {
    logger.error('student/quiz-results error', supabaseErrorFields(error));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
