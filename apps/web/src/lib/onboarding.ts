/**
 * Onboarding State Management
 * Tracks tour completion and hint dismissal in localStorage.
 * Follows the same pattern as study-codes.ts.
 */

import { STORAGE_KEYS } from './storage-keys';

const KEYS = {
  HOME_TOUR: STORAGE_KEYS.onboardingHomeTour,
  QUIZ_TOUR: STORAGE_KEYS.onboardingQuizTour,
  HINT_PREFIX: STORAGE_KEYS.hintDismissedPrefix,
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
