/**
 * Feature Flags for controlling new features
 * Set in .env.local to enable/disable features
 */

export const FEATURES = {
  // Anonymous Study Code System
  STUDY_CODES: process.env.NEXT_PUBLIC_ENABLE_STUDY_CODES === 'true',

  // Admin Dashboard
  ADMIN_PANEL: process.env.NEXT_PUBLIC_ENABLE_ADMIN_PANEL === 'true',

  // Database Sync (Supabase)
  DB_SYNC: process.env.NEXT_PUBLIC_ENABLE_DB_SYNC === 'true',

  // Progress Tracking
  PROGRESS_TRACKING: process.env.NEXT_PUBLIC_ENABLE_PROGRESS_TRACKING === 'true',

  /**
   * Skip fuzzy logic evaluation (applies to both 'writing' and 'fill-in-blank' questions)
   * - When false: Use fuzzy logic first, then Semantic API only when confidence is low
   * - When true: Skip fuzzy logic, always use Semantic API (higher accuracy, higher cost)
   */
  SKIP_FUZZY_LOGIC: false,
  // To use env var instead (server-only, runtime configurable on restart):
  // SKIP_FUZZY_LOGIC: process.env.SKIP_FUZZY_LOGIC === 'true',
} as const;

/**
 * Fuzzy logic thresholds by difficulty level
 * Determines minimum similarity required to use fuzzy logic instead of falling back to Semantic API
 * NOTE: This is NOT the "passing" threshold - see CORRECTNESS_THRESHOLDS for that
 * Values are percentages (0-100)
 */
export const FUZZY_LOGIC_THRESHOLDS = {
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
} as const;

export type DifficultyLevel = keyof typeof FUZZY_LOGIC_THRESHOLDS;

/**
 * Get the fuzzy logic threshold for a given difficulty level
 */
export function getFuzzyLogicThreshold(difficulty: string): number {
  return FUZZY_LOGIC_THRESHOLDS[difficulty as DifficultyLevel] ?? FUZZY_LOGIC_THRESHOLDS.intermediate;
}

// Helper function to check if any new feature is enabled
export const isAnyNewFeatureEnabled = () => {
  return Object.values(FEATURES).some(flag => flag === true);
};

// Log feature status in development
if (process.env.NODE_ENV === 'development') {
  console.log('🎛️  Feature Flags:', FEATURES);
}
