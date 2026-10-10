import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { loadQuestionsByIds } from '@/lib/question-loader';
import { requireStudentSession } from '@/lib/student-api-guard';
import { verifyCsrfProtection } from '@/lib/csrf';
import { quizResultsSchema } from '@/lib/api-schemas';
import { isGradedBy } from '@adaptive/shared/enums';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('student/quiz-results');

async function countRows(
  table: 'question_results' | 'quiz_history',
  studyCodeId: string,
  onlyCorrect = false,
): Promise<number | null> {
  let query = supabaseAdmin!
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('study_code_id', studyCodeId);
  if (onlyCorrect) query = query.eq('is_correct', true);

  const { count, error } = await query;
  if (error || count === null) {
    logger.error(`Error counting `, supabaseErrorFields(error));
    return null;
  }
  return count;
}

async function updateStudyCodeStats(studyCodeId: string): Promise<void> {
  const [totalQuestions, correctAnswers, totalQuizzes] = await Promise.all([
    countRows('question_results', studyCodeId),
    countRows('question_results', studyCodeId, true),
    countRows('quiz_history', studyCodeId),
  ]);
  if (totalQuestions === null || correctAnswers === null || totalQuizzes === null) return;

  const { error } = await supabaseAdmin!
    .from('study_codes')
    .update({
      total_quizzes: totalQuizzes,
      total_questions: totalQuestions,
      correct_answers: correctAnswers,
    })
    .eq('id', studyCodeId);

  if (error) {
    logger.error('Error updating study code totals', supabaseErrorFields(error));
  }
}

// Types the server can grade by comparing against the stored answer. Typed answers (fill-in-blank,
// writing) are graded by the evaluation step, whose result the client reports back.
const SERVER_GRADED_TYPES = new Set(['multiple-choice', 'true-false']);

/** The quiz route's unit id for a quiz drawn from every unit. */
const ALL_UNITS_ID = 'all';

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

  const parsed = quizResultsSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const result = parsed.data;
  const studyCodeId = session.studyCodeId;

  try {
    // A quiz covers one unit or all of them; any other unit id is not a unit the app serves.
    if (result.unitId !== ALL_UNITS_ID) {
      const { count, error: unitError } = await supabaseAdmin!
        .from('units')
        .select('id', { count: 'exact', head: true })
        .eq('id', result.unitId);

      if (unitError) {
        logger.error('Error checking unit id', supabaseErrorFields(unitError));
        return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
      }
      if (!count) {
        return NextResponse.json({ error: 'Unknown unit' }, { status: 400 });
      }
    }

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

    // The stored correct_answer comes from the questions table, and so does the is_correct
    // comparison for every question type the server can grade itself. A client-supplied
    // evaluation is used only for typed answers.
    const dbQuestions = await loadQuestionsByIds(result.questions.map((q) => q.id));

    const uniqueQuestions = [...new Map(result.questions.map((q) => [q.id, q])).values()];

    const questionResults = uniqueQuestions
      .map((question) => {
        const dbQuestion = dbQuestions.get(question.id);
        if (!dbQuestion) {
          logger.warn('Skipping quiz-results row for unknown question id', { questionId: question.id });
          return null;
        }

        const evalResult = SERVER_GRADED_TYPES.has(dbQuestion.type)
          ? undefined
          : result.evaluationResults?.[question.id];
        const isCorrect = evalResult
          ? evalResult.isCorrect
          : result.userAnswers[question.id] === dbQuestion.correctAnswer;

        // The client reports which grading path the evaluate route took; a value the enum does not
        // recognize is stored as NULL rather than trusted.
        const gradedBy = evalResult?.gradedBy;

        return {
          quiz_history_id: quizHistoryId,
          study_code_id: studyCodeId,
          question_id: question.id,
          topic: dbQuestion.topic,
          difficulty: dbQuestion.difficulty,
          is_correct: isCorrect,
          user_answer: result.userAnswers[question.id] || null,
          correct_answer: dbQuestion.correctAnswer,
          score: evalResult?.score ?? (isCorrect ? 100 : 0),
          graded_by: gradedBy !== undefined && isGradedBy(gradedBy) ? gradedBy : null,
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
