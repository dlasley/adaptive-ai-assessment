/**
 * Proves the reviewer sheet's column descriptions read from `COURSE_CONTENT.language`
 * (`@adaptive/shared/course`) rather than a hard-coded language name. Mocks the course module to a
 * synthetic language so the test fails if a "French" literal — or any other real course's name —
 * ever creeps back into `lib/eval/review-export.ts`; the other tests in this suite only ever see the
 * real course, so they couldn't catch a hard-coded literal that happens to match it.
 */

import { describe, expect, it, vi } from 'vitest';

const SYNTHETIC_LANGUAGE = 'Wobblish';

vi.mock('@adaptive/shared/course', () => ({
  COURSE_CONTENT: {
    language: SYNTHETIC_LANGUAGE,
    nativeLanguageName: 'Wobblish (native)',
    specialCharacters: [],
    feedback: {},
  },
}));

describe('eval-review-export reviewer sheet column descriptions', () => {
  it('use the mocked course language, with no "French" literal anywhere in the column set', async () => {
    const { AUDIT_COLUMNS, GRADING_COLUMNS } = await import('../src/lib/eval/review-export');
    const allDescriptions = [...AUDIT_COLUMNS, ...GRADING_COLUMNS].map((c) => c.description).join('\n');

    expect(allDescriptions).toContain(SYNTHETIC_LANGUAGE);
    expect(allDescriptions).not.toMatch(/french/i);
  });

  it('substitutes the synthetic language into the grammar and naturalness criterion descriptions specifically', async () => {
    const { AUDIT_COLUMNS } = await import('../src/lib/eval/review-export');
    const grammar = AUDIT_COLUMNS.find((c) => c.name === 'grammar_correct')!;
    const naturalness = AUDIT_COLUMNS.find((c) => c.name === 'natural_language')!;

    expect(grammar.description).toContain(SYNTHETIC_LANGUAGE);
    expect(naturalness.description).toContain(SYNTHETIC_LANGUAGE);
  });
});
