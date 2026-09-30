/**
 * Canonical localStorage key names for this app, all under one prefix.
 * Modules that read or write localStorage import their keys from here
 * instead of writing the prefix themselves.
 */
const PREFIX = 'adaptive_';

export const STORAGE_KEYS = {
  studyCode: `${PREFIX}study_code`,
  skipChoice: `${PREFIX}skip_choice`,
  onboardingHomeTour: `${PREFIX}onboarding_home_tour`,
  onboardingQuizTour: `${PREFIX}onboarding_quiz_tour`,
  hintDismissedPrefix: `${PREFIX}hint_dismissed_`,
  soundEnabled: `${PREFIX}sound_enabled`,
  animationsEnabled: `${PREFIX}animations_enabled`,
} as const;
