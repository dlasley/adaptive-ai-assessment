/**
 * Milestone Detection
 * Pure logic to detect achievements by comparing current quiz results
 * against historical data. No side effects.
 */

import type { QuizHistory } from './supabase';

export interface MilestoneDetectionInput {
  scorePercentage: number;
  unitId: string;
  difficulty: string;
  isAssessmentMode: boolean;
  quizHistory: QuizHistory[];
  previousProgress: {
    totalQuizzes: number;
    totalQuestions: number;
    correctAnswers: number;
    overallAccuracy: number;
  } | null;
  currentCorrectAnswers: number;
  currentTotalQuestions: number;
}

export interface MilestoneResult {
  isPerfectScore: boolean;
  isNewHighScore: boolean;
  isNewOverallHighScore: boolean;
  previousBest: number | null;
  previousOverallBest: number | null;
  isAssessmentMode: boolean;
  quizCountMilestone: number | null;
  accuracyThresholdCrossed: number | null;
}

const QUIZ_MILESTONES = [10, 25, 50, 100];
const ACCURACY_THRESHOLDS = [70, 80, 90];

export function detectMilestones(input: MilestoneDetectionInput): MilestoneResult {
  const {
    scorePercentage,
    unitId,
    difficulty,
    isAssessmentMode,
    quizHistory,
    previousProgress,
    currentCorrectAnswers,
    currentTotalQuestions,
  } = input;

  // Perfect score
  const isPerfectScore = scorePercentage === 100;

  // New high score for this unit + difficulty
  const matchingHistory = quizHistory.filter(
    (q) => q.unit_id === unitId && q.difficulty === difficulty
  );
  const previousBest = matchingHistory.length > 0
    ? Math.max(...matchingHistory.map((q) => q.score_percentage))
    : null;
  const isNewHighScore = previousBest === null
    ? true // First quiz for this combo is always a "best"
    : scorePercentage > previousBest;

  // New overall high score
  const previousOverallBest = quizHistory.length > 0
    ? Math.max(...quizHistory.map((q) => q.score_percentage))
    : null;
  const isNewOverallHighScore = previousOverallBest === null
    ? true
    : scorePercentage > previousOverallBest;

  // Quiz count milestone
  const newQuizCount = (previousProgress?.totalQuizzes ?? 0) + 1;
  const quizCountMilestone = QUIZ_MILESTONES.includes(newQuizCount) ? newQuizCount : null;

  // Accuracy threshold crossing
  let accuracyThresholdCrossed: number | null = null;
  if (previousProgress) {
    const oldAccuracy = previousProgress.overallAccuracy;
    const newTotalCorrect = previousProgress.correctAnswers + currentCorrectAnswers;
    const newTotalQuestions = previousProgress.totalQuestions + currentTotalQuestions;
    const newAccuracy = newTotalQuestions > 0
      ? (newTotalCorrect / newTotalQuestions) * 100
      : 0;

    for (const threshold of ACCURACY_THRESHOLDS) {
      if (oldAccuracy < threshold && newAccuracy >= threshold) {
        accuracyThresholdCrossed = threshold;
        break; // Report highest threshold crossed
      }
    }
    // Check in reverse for highest threshold
    for (let i = ACCURACY_THRESHOLDS.length - 1; i >= 0; i--) {
      if (oldAccuracy < ACCURACY_THRESHOLDS[i] && newAccuracy >= ACCURACY_THRESHOLDS[i]) {
        accuracyThresholdCrossed = ACCURACY_THRESHOLDS[i];
        break;
      }
    }
  }

  return {
    isPerfectScore,
    isNewHighScore,
    isNewOverallHighScore,
    previousBest,
    previousOverallBest,
    isAssessmentMode,
    quizCountMilestone,
    accuracyThresholdCrossed,
  };
}
