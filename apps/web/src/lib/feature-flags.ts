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
   * Disables the fuzzy-match tier (applies to both 'writing' and 'fill-in-blank' questions)
   * - When false: the fuzzy-match tier grades an answer it matches, and the semantic tier grades the rest
   * - When true: skip the fuzzy-match tier, always use the semantic tier (higher accuracy, higher cost)
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
 * Score thresholds for deciding whether a graded answer counts as correct.
 */
export const CORRECTNESS_THRESHOLDS = {
  /** Semantic tier: score >= this value = correct */
  SEMANTIC_PASS: 70,
} as const;

logger.debug('Feature flags', FEATURES);
