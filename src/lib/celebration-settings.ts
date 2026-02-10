/**
 * Celebration Settings
 * Manages sound and animation preferences in localStorage.
 * Follows the same pattern as onboarding.ts.
 */

const KEYS = {
  SOUND_ENABLED: 'french_sound_enabled',
  ANIMATIONS_ENABLED: 'french_animations_enabled',
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

export function setAnimationsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.ANIMATIONS_ENABLED, enabled.toString());
}

export function resetCelebrationSettings(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEYS.SOUND_ENABLED);
  localStorage.removeItem(KEYS.ANIMATIONS_ENABLED);
}
