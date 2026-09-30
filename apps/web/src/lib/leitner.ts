/**
 * Leitner Spaced Repetition System
 *
 * Implements a 5-box Leitner system for adaptive question selection.
 * Questions move between boxes based on correct/incorrect answers:
 * - Wrong answer → box 1 (reset streak)
 * - Correct answers → promote after reaching threshold for current box
 *
 * Box weights control selection probability during quiz generation:
 * higher weight = more likely to appear in a quiz.
 */

/** How many consecutive correct answers needed to promote from each box */
const BOX_PROMOTION_THRESHOLDS: Record<number, number> = {
  1: 1, // Box 1 → 2: 1 correct
  2: 2, // Box 2 → 3: 2 consecutive correct
  3: 2, // Box 3 → 4: 2 consecutive correct
  4: 3, // Box 4 → 5: 3 consecutive correct
};

/** Selection weights by box (higher = more likely to appear in quiz) */
const BOX_WEIGHTS: Record<number, number> = {
  1: 5,
  2: 4,
  3: 3,
  4: 2,
  5: 1,
};

/** Weight for questions the student has never seen */
const UNSEEN_QUESTION_WEIGHT = 3;

/** Maximum Leitner box number */
const MAX_BOX = 5;

/**
 * Calculate the new box and consecutive_correct after an answer
 */
export function calculateNewBox(
  currentBox: number,
  consecutiveCorrect: number,
  isCorrect: boolean
): { box: number; consecutiveCorrect: number } {
  if (!isCorrect) {
    return { box: 1, consecutiveCorrect: 0 };
  }

  const newConsecutive = consecutiveCorrect + 1;
  const threshold = BOX_PROMOTION_THRESHOLDS[currentBox];

  if (!threshold || currentBox >= MAX_BOX) {
    return { box: currentBox, consecutiveCorrect: newConsecutive };
  }

  if (newConsecutive >= threshold) {
    return { box: currentBox + 1, consecutiveCorrect: 0 };
  }

  return { box: currentBox, consecutiveCorrect: newConsecutive };
}

/**
 * Get the selection weight for a question based on its Leitner box.
 * Returns UNSEEN_QUESTION_WEIGHT for questions with no Leitner state.
 */
export function getQuestionWeight(box: number | null): number {
  if (box === null) return UNSEEN_QUESTION_WEIGHT;
  return BOX_WEIGHTS[box] ?? UNSEEN_QUESTION_WEIGHT;
}
