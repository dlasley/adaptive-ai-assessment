/**
 * Onboarding State Management
 * Tracks tour completion and hint dismissal in localStorage.
 * Follows the same pattern as study-codes.ts.
 */

const KEYS = {
  HOME_TOUR: 'french_onboarding_home_tour',
  QUIZ_TOUR: 'french_onboarding_quiz_tour',
  HINT_PREFIX: 'french_hint_dismissed_',
};

export function isHomeTourComplete(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(KEYS.HOME_TOUR) === 'true';
}

export function setHomeTourComplete(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.HOME_TOUR, 'true');
}

export function isQuizTourComplete(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(KEYS.QUIZ_TOUR) === 'true';
}

export function setQuizTourComplete(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.QUIZ_TOUR, 'true');
}

export function isHintDismissed(hintId: string): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(KEYS.HINT_PREFIX + hintId) === 'true';
}

export function dismissHint(hintId: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.HINT_PREFIX + hintId, 'true');
}

export function resetAllOnboarding(): void {
  if (typeof window === 'undefined') return;
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('french_onboarding_') || key.startsWith('french_hint_dismissed_'))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
}
