/**
 * Progress Tracking
 * Saves quiz results and question-level data via the session-scoped
 * student API routes. Study code identity comes from the server's own
 * session cookie, never from a client-supplied id.
 */

import { Question } from '@adaptive/shared/types';
import type { Difficulty } from '@adaptive/shared/enums';
import { STUDY_CODE_KEY } from './study-codes';

export interface QuizResult {
  unitId: string;
  difficulty: Difficulty;
  totalQuestions: number;
  correctAnswers: number;
  scorePercentage: number;
  timeSpentSeconds?: number;
  questions: Question[];
  userAnswers: Record<string, string>;
  evaluationResults?: Record<string, { isCorrect: boolean; score?: number }>;
}

/**
 * Save quiz results via POST /api/student/quiz-results.
 * Returns quiz_history_id on success, null on failure.
 */
export async function saveQuizResults(result: QuizResult): Promise<string | null> {
  try {
    const response = await fetch('/api/student/quiz-results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unitId: result.unitId,
        difficulty: result.difficulty,
        totalQuestions: result.totalQuestions,
        correctAnswers: result.correctAnswers,
        scorePercentage: result.scorePercentage,
        timeSpentSeconds: result.timeSpentSeconds,
        questions: result.questions.map((q) => ({
          id: q.id,
          topic: q.topic,
          difficulty: q.difficulty,
        })),
        userAnswers: result.userAnswers,
        evaluationResults: result.evaluationResults,
      }),
    });

    if (!response.ok) {
      console.error('Failed to save quiz results:', response.statusText);
      return null;
    }

    const { quizHistoryId } = await response.json();
    return quizHistoryId ?? null;
  } catch (error) {
    console.error('Failed to save quiz results:', error);
    return null;
  }
}

/**
 * Update Leitner state for a single question immediately after it's
 * answered, via POST /api/student/leitner. Fire-and-forget: callers
 * should not await this.
 */
export async function updateLeitnerStateForQuestion(
  questionId: string,
  isCorrect: boolean
): Promise<void> {
  try {
    const response = await fetch('/api/student/leitner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, isCorrect }),
    });

    if (!response.ok) {
      console.error('Failed to update Leitner state:', response.statusText);
    }
  } catch (error) {
    console.error('Failed to update Leitner state:', error);
  }
}

/**
 * Save quiz results to localStorage (fallback when the server save fails)
 */
export function saveQuizResultsLocally(result: QuizResult): void {
  if (typeof window === 'undefined') return;

  const studyCode = localStorage.getItem(STUDY_CODE_KEY);
  if (!studyCode) return;

  try {
    const key = `quiz_history_${studyCode}`;
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
