/**
 * UI copy derived from course settings (icon, language, native language name, special
 * characters). Kept as pure builders, parameterized by the course strings they need, so the
 * wording is unit-testable without mounting a component.
 */

const GLOBE_ICON = '🌐';

/** Header text: the course icon (if any) followed by the title, with no stray spacing when there's no icon. */
export function buildHeaderText(title: string, icon: string | undefined): string {
  return icon ? `${icon} ${title}` : title;
}

export interface InlineKeyboardTip {
  intro: string;
  globeLabel: string;
  middle: string;
  languageName: string;
  suffix: string;
}

/**
 * Tip shown inline below the answer input on narrow screens, split into the pieces the component
 * renders with bold styling. Concatenating intro + globeLabel + middle + languageName + suffix
 * reproduces the full sentence.
 */
export function buildInlineKeyboardTip(language: string, nativeLanguageName: string): InlineKeyboardTip {
  return {
    intro: `Switch your keyboard to ${language} to avoid auto-correct! Tap the `,
    globeLabel: `${GLOBE_ICON} globe icon`,
    middle: ' and select ',
    languageName: nativeLanguageName,
    suffix: '.',
  };
}

/** Tip shown in the quiz page's onboarding tour on narrow screens. */
export function buildOnboardingKeyboardTip(
  language: string,
  nativeLanguageName: string,
  specialCharacters: string[]
): string {
  const accentKeys = specialCharacters.join(', ');
  return `Tip: Switch your phone keyboard to ${language} to avoid auto-correct! On iPhone, tap the ${GLOBE_ICON} globe icon on your keyboard and select "${nativeLanguageName}". This gives you accent keys (${accentKeys}) without long-pressing.`;
}
