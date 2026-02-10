/**
 * Progress Tracking
 * Saves quiz results and question-level data to database
 */

import { supabase, isSupabaseAvailable } from './supabase';
import { Question } from '@/types';
import { FEATURES } from './feature-flags';
import { calculateNewBox } from './leitner';

export interface QuizResult {
  studyCode: string;
  unitId: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  totalQuestions: number;
  correctAnswers: number;
  scorePercentage: number;
  timeSpentSeconds?: number;
  questions: Question[];
  userAnswers: Record<string, string>;
  evaluationResults?: Record<string, { isCorrect: boolean; score?: number }>;
}

/**
 * Save quiz results to database
 * Returns quiz_history_id on success, null on failure
 */
export async function saveQuizResults(result: QuizResult): Promise<string | null> {
  if (!isSupabaseAvailable()) {
    console.log('Supabase not available, skipping save');
    return null;
  }

  try {
    // Get study code ID
    const { data: studyCodeData, error: codeError } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', result.studyCode)
      .single();

    if (codeError || !studyCodeData) {
      console.error('Study code not found:', codeError);
      return null;
    }

    const studyCodeId = studyCodeData.id;

    // Insert quiz history
    const { data: quizData, error: quizError } = await supabase!
      .from('quiz_history')
      .insert({
        study_code_id: studyCodeId,
        unit_id: result.unitId,
        difficulty: result.difficulty,
        total_questions: result.totalQuestions,
        correct_answers: result.correctAnswers,
        score_percentage: result.scorePercentage,
        time_spent_seconds: result.timeSpentSeconds || null,
      })
      .select()
      .single();

    if (quizError || !quizData) {
      console.error('Error saving quiz history:', quizError);
      return null;
    }

    const quizHistoryId = quizData.id;

    // Insert question results
    const questionResults = result.questions.map((question) => {
      // For typed-answer questions with evaluation results, use evaluation's isCorrect
      const evalResult = result.evaluationResults?.[question.id];
      const isCorrect = evalResult
        ? evalResult.isCorrect
        : result.userAnswers[question.id] === question.correctAnswer;

      return {
        quiz_history_id: quizHistoryId,
        study_code_id: studyCodeId,
        question_id: question.id,
        topic: question.topic,
        difficulty: question.difficulty,
        is_correct: isCorrect,
        user_answer: result.userAnswers[question.id] || null,
        correct_answer: question.correctAnswer,
        score: evalResult?.score ?? (isCorrect ? 100 : 0),
      };
    });

    const { error: resultsError } = await supabase!
      .from('question_results')
      .insert(questionResults);

    if (resultsError) {
      console.error('Error saving question results:', resultsError);
      // Quiz history is saved, so we return the ID even if question details fail
    }

    // Update study code stats
    await updateStudyCodeStats(studyCodeId);

    // Update Leitner state if adaptive mode is enabled
    if (FEATURES.LEITNER_MODE) {
      const leitnerUpdates = questionResults.map((qr) => ({
        questionId: qr.question_id,
        isCorrect: qr.is_correct,
      }));
      await updateLeitnerState(studyCodeId, leitnerUpdates);
    }

    return quizHistoryId;
  } catch (error) {
    console.error('Failed to save quiz results:', error);
    return null;
  }
}

/**
 * Update aggregate stats for a study code
 */
async function updateStudyCodeStats(studyCodeId: string): Promise<void> {
  if (!isSupabaseAvailable()) return;

  try {
    // Get aggregated stats
    const { data, error } = await supabase!
      .from('question_results')
      .select('is_correct', { count: 'exact' })
      .eq('study_code_id', studyCodeId);

    if (error || !data) {
      console.error('Error getting stats:', error);
      return;
    }

    const totalQuestions = data.length;
    const correctAnswers = data.filter((r) => r.is_correct).length;

    // Get total quizzes
    const { data: quizData, error: quizError } = await supabase!
      .from('quiz_history')
      .select('id', { count: 'exact' })
      .eq('study_code_id', studyCodeId);

    if (quizError) {
      console.error('Error getting quiz count:', quizError);
      return;
    }

    const totalQuizzes = quizData?.length || 0;

    // Update study code
    await supabase!
      .from('study_codes')
      .update({
        total_quizzes: totalQuizzes,
        total_questions: totalQuestions,
        correct_answers: correctAnswers,
      })
      .eq('id', studyCodeId);
  } catch (error) {
    console.error('Failed to update study code stats:', error);
  }
}

/**
 * Get overall progress for a study code
 */
export async function getProgress(studyCode: string): Promise<{
  totalQuizzes: number;
  totalQuestions: number;
  correctAnswers: number;
  overallAccuracy: number;
} | null> {
  if (!isSupabaseAvailable()) return null;

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('total_quizzes, total_questions, correct_answers')
      .eq('code', studyCode)
      .single();

    if (error || !data) {
      console.error('Error getting progress:', error);
      return null;
    }

    const overallAccuracy =
      data.total_questions > 0
        ? Math.round((data.correct_answers / data.total_questions) * 100 * 100) / 100
        : 0;

    return {
      totalQuizzes: data.total_quizzes,
      totalQuestions: data.total_questions,
      correctAnswers: data.correct_answers,
      overallAccuracy,
    };
  } catch (error) {
    console.error('Failed to get progress:', error);
    return null;
  }
}

/**
 * Update Leitner state for all questions in a completed quiz.
 * Creates entries for unseen questions, updates existing ones.
 */
async function updateLeitnerState(
  studyCodeId: string,
  questionResults: Array<{ questionId: string; isCorrect: boolean }>
): Promise<void> {
  if (!isSupabaseAvailable()) return;

  try {
    const questionIds = questionResults.map((r) => r.questionId);

    // Fetch existing Leitner state for these questions
    const { data: existingStates, error: fetchError } = await supabase!
      .from('leitner_state')
      .select('question_id, box, consecutive_correct')
      .eq('study_code_id', studyCodeId)
      .in('question_id', questionIds);

    if (fetchError) {
      console.error('Error fetching Leitner state:', fetchError);
      return;
    }

    const stateMap = new Map(
      (existingStates || []).map((s) => [
        s.question_id,
        { box: s.box as number, consecutiveCorrect: s.consecutive_correct as number },
      ])
    );

    // Calculate new states
    const upserts = questionResults.map(({ questionId, isCorrect }) => {
      const existing = stateMap.get(questionId);
      const { box, consecutiveCorrect } = calculateNewBox(
        existing?.box ?? 1,
        existing?.consecutiveCorrect ?? 0,
        isCorrect
      );

      return {
        study_code_id: studyCodeId,
        question_id: questionId,
        box,
        consecutive_correct: consecutiveCorrect,
        last_reviewed: new Date().toISOString(),
      };
    });

    const { error: upsertError } = await supabase!
      .from('leitner_state')
      .upsert(upserts, { onConflict: 'study_code_id,question_id' });

    if (upsertError) {
      console.error('Error updating Leitner state:', upsertError);
    }
  } catch (error) {
    console.error('Failed to update Leitner state:', error);
  }
}

/**
 * Save quiz results to localStorage (fallback when DB not available)
 */
export function saveQuizResultsLocally(result: QuizResult): void {
  if (typeof window === 'undefined') return;

  try {
    const key = `quiz_history_${result.studyCode}`;
    const existing = localStorage.getItem(key);
    const history = existing ? JSON.parse(existing) : [];

    history.unshift({
      date: new Date().toISOString(),
      unitId: result.unitId,
      difficulty: result.difficulty,
      score: result.scorePercentage,
      totalQuestions: result.totalQuestions,
      correctAnswers: result.correctAnswers,
    });

    // Keep only last 50 quizzes
    const trimmed = history.slice(0, 50);
    localStorage.setItem(key, JSON.stringify(trimmed));
  } catch (error) {
    console.error('Failed to save quiz results locally:', error);
  }
}