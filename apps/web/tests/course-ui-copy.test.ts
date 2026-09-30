import { describe, expect, it } from 'vitest';
import { buildHeaderText, buildInlineKeyboardTip, buildOnboardingKeyboardTip } from '@/lib/course-ui-copy';
import { COURSE_CONTENT } from '@adaptive/shared/course';

describe('buildHeaderText', () => {
  it('prefixes the title with the icon and a space when an icon is set', () => {
    expect(buildHeaderText('French II Practice & Assessment', '🇫🇷')).toBe(
      '🇫🇷 French II Practice & Assessment'
    );
  });

  it('returns the title alone, with no stray spacing, when there is no icon', () => {
    expect(buildHeaderText('French II Practice & Assessment', undefined)).toBe(
      'French II Practice & Assessment'
    );
  });
});

describe('buildInlineKeyboardTip', () => {
  // Pinned against the hardcoded JSX this replaced in writing-answer-input.tsx: concatenating
  // intro + globeLabel + middle + languageName + suffix must reproduce that exact sentence.
  it('reproduces the original hardcoded sentence for the current course', () => {
    const tip = buildInlineKeyboardTip(COURSE_CONTENT.language, COURSE_CONTENT.nativeLanguageName);
    const rendered = tip.intro + tip.globeLabel + tip.middle + tip.languageName + tip.suffix;

    expect(rendered).toBe(
      'Switch your keyboard to French to avoid auto-correct! Tap the 🌐 globe icon and select Français.'
    );
  });
});

describe('buildOnboardingKeyboardTip', () => {
  // Pinned against the hardcoded template this replaced in quiz/[unitId]/page.tsx.
  it('reproduces the original hardcoded tip for the current course', () => {
    const rendered = buildOnboardingKeyboardTip(
      COURSE_CONTENT.language,
      COURSE_CONTENT.nativeLanguageName,
      COURSE_CONTENT.specialCharacters
    );

    expect(rendered).toBe(
      'Tip: Switch your phone keyboard to French to avoid auto-correct! On iPhone, tap the 🌐 globe icon on your keyboard and select "Français". This gives you accent keys (é, è, ê) without long-pressing.'
    );
  });
});
