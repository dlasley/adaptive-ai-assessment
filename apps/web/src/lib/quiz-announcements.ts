/**
 * Screen-reader announcement text for quiz evaluation and progress events.
 * Kept as pure string builders so the live-region wording can be unit
 * tested without mounting a component.
 */

export const EVALUATING_ANNOUNCEMENT = 'Evaluating your answer.';

export function getEvaluationAnnouncement(isCorrect: boolean): string {
  return isCorrect ? 'Correct!' : 'Not quite right, see feedback below.';
}

export function getProgressAnnouncement(questionNumber: number, totalQuestions: number): string {
  return `Question ${questionNumber} of ${totalQuestions}`;
}
