/**
 * Feature flags. Flags read from `NEXT_PUBLIC_*` variables are set per environment; the rest are
 * code constants, changed here and shipped with a deploy.
 */

import { createLogger } from './logger';

const logger = createLogger('feature-flags');

export const FEATURES = {
  // Admin Dashboard
  ADMIN_PANEL: process.env.NEXT_PUBLIC_ENABLE_ADMIN_PANEL === 'true',

  /**
   * Skip fuzzy logic evaluation (applies to both 'writing' and 'fill-in-blank' questions)
   * - When false: Use fuzzy logic first, then Semantic API only when confidence is low
   * - When true: Skip fuzzy logic, always use Semantic API (higher accuracy, higher cost)
   */
  SKIP_FUZZY_LOGIC: false,

  // Suggested reading time shown on "Next Question" after a wrong answer (0 = no countdown)
  WRONG_ANSWER_COUNTDOWN_SECONDS: 15,

  // Seconds "Next Question" stays disabled at the start of that countdown
  WRONG_ANSWER_MIN_WAIT_SECONDS: 3,

  // Leitner adaptive question selection (spaced repetition)
  LEITNER_MODE: process.env.NEXT_PUBLIC_ENABLE_LEITNER === 'true',
} as const;

/**
 * Fuzzy logic thresholds by difficulty level
 * Determines minimum similarity required to use fuzzy logic instead of falling back to Semantic API
 * NOTE: This is NOT the "passing" threshold - see CORRECTNESS_THRESHOLDS for that
 * Values are percentages (0-100)
 */
const FUZZY_LOGIC_THRESHOLDS = {
  beginner: 70,
  intermediate: 85,
  advanced: 95,
} as const;

/**
 * Correctness thresholds for fuzzy logic evaluation
 * These determine whether an answer is marked correct based on similarity score
 */
export const CORRECTNESS_THRESHOLDS = {
  /** 95%+ similarity = correct (minor typo) */
  MINOR_TYPO: 95,
  /** 85-94% similarity = correct only for beginners */
  BEGINNER_PASS: 85,
  /** Below 85% = incorrect (even if above fuzzy logic threshold) */
  /** Semantic API: score >= this value = correct */
  SEMANTIC_API_PASS: 70,
} as const;

type DifficultyLevel = keyof typeof FUZZY_LOGIC_THRESHOLDS;

/**
 * Get the fuzzy logic threshold for a given difficulty level
 */
export function getFuzzyLogicThreshold(difficulty: string): number {
  return FUZZY_LOGIC_THRESHOLDS[difficulty as DifficultyLevel] ?? FUZZY_LOGIC_THRESHOLDS.intermediate;
}

logger.debug('Feature flags', FEATURES);
