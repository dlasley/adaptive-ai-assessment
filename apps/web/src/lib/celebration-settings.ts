/**
 * Celebration Settings
 * Manages sound and animation preferences in localStorage.
 * Follows the same pattern as onboarding.ts.
 */

import { STORAGE_KEYS } from './storage-keys';

const KEYS = {
  SOUND_ENABLED: STORAGE_KEYS.soundEnabled,
  ANIMATIONS_ENABLED: STORAGE_KEYS.animationsEnabled,
};

export function isSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = localStorage.getItem(KEYS.SOUND_ENABLED);
  return stored === null ? true : stored === 'true';
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.SOUND_ENABLED, enabled.toString());
}

export function isAnimationsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = localStorage.getItem(KEYS.ANIMATIONS_ENABLED);
  return stored === null ? true : stored === 'true';
}
