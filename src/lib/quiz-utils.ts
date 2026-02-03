/**
 * Shared Quiz Utilities
 * Common functionality reusable across different quiz types
 */

import type { EvaluationResult } from '@/app/api/evaluate-writing/route';

export interface QuizResult {
  question: string;
  answer: string;
  evaluation: EvaluationResult;
}

export interface QuizStats {
  averageScore: number;
  correctCount: number;
  accentAccuracy: number;
  totalQuestions: number;
}

/**
 * Calculate quiz statistics from results
 */
export function calculateQuizStats(results: QuizResult[]): QuizStats {
  if (results.length === 0) {
    return {
      averageScore: 0,
      correctCount: 0,
      accentAccuracy: 0,
      totalQuestions: 0
    };
  }

  const averageScore = Math.round(
    results.reduce((sum, r) => sum + r.evaluation.score, 0) / results.length
  );

  const correctCount = results.filter(r => r.evaluation.isCorrect).length;
  const accentAccuracy = results.filter(r => r.evaluation.hasCorrectAccents).length;

  return {
    averageScore,
    correctCount,
    accentAccuracy,
    totalQuestions: results.length
  };
}

/**
 * Calculate progress percentage
 */
export function calculateProgress(current: number, total: number): number {
  if (total === 0) return 0;
  return ((current + 1) / total) * 100;
}

/**
 * Get performance level description based on average score
 */
export function getPerformanceLevel(averageScore: number): {
  label: string;
  color: string;
  message: string;
} {
  if (averageScore >= 90) {
    return {
      label: 'Excellent',
      color: 'green',
      message: 'Outstanding work! You have a strong grasp of French.'
    };
  } else if (averageScore >= 80) {
    return {
      label: 'Very Good',
      color: 'blue',
      message: 'Great job! Keep practicing to reach excellence.'
    };
  } else if (averageScore >= 70) {
    return {
      label: 'Good',
      color: 'yellow',
      message: 'Good progress! Focus on the areas where you struggled.'
    };
  } else if (averageScore >= 60) {
    return {
      label: 'Fair',
      color: 'orange',
      message: 'Keep working! Review the topics and try again.'
    };
  } else {
    return {
      label: 'Needs Improvement',
      color: 'red',
      message: 'Don\'t give up! Review the material and practice more.'
    };
  }
}
