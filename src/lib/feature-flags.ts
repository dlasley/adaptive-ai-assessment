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

  // Writing Evaluation Mode
  // When false: Use fuzzy logic first, then Claude API only when confidence is low
  // When true: Always use Claude API for maximum accuracy (higher cost)
  API_ONLY_EVALUATION: process.env.NEXT_PUBLIC_API_ONLY_EVALUATION === 'true',
} as const;

// Helper function to check if any new feature is enabled
export const isAnyNewFeatureEnabled = () => {
  return Object.values(FEATURES).some(flag => flag === true);
};

// Log feature status in development
if (process.env.NODE_ENV === 'development') {
  console.log('🎛️  Feature Flags:', FEATURES);
}
