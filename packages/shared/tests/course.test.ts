import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * getCourse() memoizes after its first successful call, so each scenario needs a fresh module
 * instance — vi.resetModules() + a dynamic import, the same pattern apps/web/tests/csp.test.ts
 * uses for next.config's own NODE_ENV-dependent module-load behavior. Importing the module itself
 * never reads env or throws now — only calling getCourse() (or renderCoursePrompt(), which calls
 * it) does, which each test does explicitly.
 */
async function importCourse() {
  vi.resetModules();
  return import('../src/course');
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.COURSE_NAME;
  delete process.env.COURSE_TITLE;
  delete process.env.NEXT_PHASE;
});

describe('getCourse', () => {
  it('reads name and title from env vars when both are set', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse } = await importCourse();
    const course = getCourse();

    expect(course.name).toBe('French III');
    expect(course.title).toBe('French III Practice & Assessment');
  });

  it('falls back to the dev default outside production when unset', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse } = await importCourse();
    const course = getCourse();

    expect(course.name).toBe('French II');
    expect(course.title).toBe('French II Practice & Assessment');
  });

  it('falls back to the dev default during a local `next build`', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    process.env.NEXT_PHASE = 'phase-production-build';

    const { getCourse } = await importCourse();

    expect(getCourse().name).toBe('French II');
  });

  it('throws in a real production runtime (not the build phase) when unset', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.NEXT_PHASE;

    const { getCourse } = await importCourse();

    expect(() => getCourse()).toThrow('COURSE_NAME is not set');
  });

  it('throws during a Vercel build when unset, so static pages never bake in the fallback', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    process.env.NEXT_PHASE = 'phase-production-build';

    const { getCourse } = await importCourse();

    expect(() => getCourse()).toThrow('COURSE_NAME is not set');
  });

  it('does not read env or throw merely from being imported', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    process.env.NEXT_PHASE = 'phase-production-build';

    // The import itself must not throw, even though calling getCourse() right after would (per
    // the previous test) — that's the whole point of making this lazy.
    await expect(importCourse()).resolves.toBeDefined();
  });

  it('memoizes after a successful read — a later env change has no effect', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse } = await importCourse();
    const first = getCourse();

    process.env.COURSE_NAME = 'French IV';
    const second = getCourse();

    expect(first.name).toBe('French III');
    expect(second.name).toBe('French III');
  });

  it('does not memoize a failed read — a later call can still succeed once the env is fixed', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    process.env.NEXT_PHASE = 'phase-production-build';

    const { getCourse } = await importCourse();
    expect(() => getCourse()).toThrow('COURSE_NAME is not set');

    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    expect(getCourse().name).toBe('French III');
  });

  it('derives level.description from the resolved course name', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse } = await importCourse();

    expect(getCourse().level.description).toContain('French III');
  });
});

describe('COURSE_CONTENT', () => {
  it('is readable with no env vars set and in a context where getCourse() would throw', async () => {
    delete process.env.COURSE_NAME;
    delete process.env.COURSE_TITLE;
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    delete process.env.NEXT_PHASE;

    const { COURSE_CONTENT } = await importCourse();

    expect(COURSE_CONTENT.language).toBe('French');
    expect(COURSE_CONTENT.feedback.exactMatchWithAccents).toBeTruthy();
  });

  // Pinned against the current course's values, typed independently of course.ts, so a wording
  // or ordering change shows up as a failing diff here instead of passing silently.
  it('matches the current course icon, native language name, and special characters exactly', async () => {
    const { COURSE_CONTENT } = await importCourse();

    expect(COURSE_CONTENT.icon).toBe('🇫🇷');
    expect(COURSE_CONTENT.nativeLanguageName).toBe('Français');
    expect(COURSE_CONTENT.specialCharacters).toEqual(['é', 'è', 'ê']);
  });

  it('supplies getCourse()\'s language and feedback fields unchanged', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse, COURSE_CONTENT } = await importCourse();
    const course = getCourse();

    expect(course.language).toBe(COURSE_CONTENT.language);
    expect(course.feedback).toBe(COURSE_CONTENT.feedback);
  });
});

describe('COURSE_CONTENT.feedback literal text', () => {
  // Pinned against the hardcoded strings this content replaced — apps/web/src/lib/typed-answer-evaluation.ts and
  // apps/web/src/app/api/evaluate-writing/route.ts as of commit ae7d788, before the move into course.ts. The
  // literals below are typed independently of course.ts, not read back from it, so a wording change in course.ts
  // shows up as a failing diff here instead of passing silently.
  it('matches every original hardcoded feedback string exactly', async () => {
    const { COURSE_CONTENT } = await importCourse();
    const { feedback } = COURSE_CONTENT;

    expect(feedback.answerTooShort).toBe('Réponse trop courte. Veuillez fournir une réponse complète.');
    expect(feedback.answerTooShortSuggestion).toBe("Essayez d'écrire une réponse complète en français.");
    expect(feedback.exactMatchWithAccents).toBe('Parfait ! Réponse correcte avec les accents appropriés.');
    expect(feedback.exactMatchMissingAccents).toBe('Correct ! Attention aux accents pour être parfait.');
    expect(feedback.variationExactWithAccents).toBe("Très bien ! C'est une variation acceptable.");
    expect(feedback.variationExactMissingAccents).toBe('Bien ! Attention aux accents. Variation acceptable.');
    expect(feedback.variationCloseMatch).toBe('Presque parfait ! Petite erreur dans une variation acceptable.');
    expect(feedback.fuzzyMinorTypo).toBe('Presque parfait ! Attention aux petites erreurs.');
    expect(feedback.fuzzyBeginnerPass).toBe('Bon effort ! Quelques petites erreurs à corriger.');
    expect(feedback.fuzzyBeginnerPassIneligible).toBe('Pas mal, mais il y a des erreurs à corriger.');
    expect(feedback.fuzzyBelowThreshold).toBe('Vous êtes sur la bonne voie, mais il y a plusieurs erreurs.');
    expect(feedback.evaluationRequestFailed).toBe('Unable to evaluate. Please try again.');
    expect(feedback.evaluationApiFailed).toBe(
      'Unable to evaluate automatically. Please try again or ask your teacher for feedback.'
    );
  });

  it('matches the original correction-template output for a sample argument', async () => {
    const { COURSE_CONTENT } = await importCourse();
    const { feedback } = COURSE_CONTENT;

    expect(feedback.correctAnswerIs('café')).toBe('La réponse correcte est: "café"');
    expect(feedback.variationCorrectIs('café')).toBe('Une variation correcte est: "café"');
  });
});

describe('renderCoursePrompt', () => {
  it('substitutes all three placeholders', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { getCourse, renderCoursePrompt } = await importCourse();
    const course = getCourse();

    const rendered = renderCoursePrompt('# {{COURSE_NAME}}\n\nLevel: {{COURSE_LEVEL}}\n\nLanguage: {{COURSE_LANGUAGE}}');

    expect(rendered).toBe(`# ${course.name}\n\nLevel: ${course.level.description}\n\nLanguage: ${course.language}`);
    expect(rendered).not.toContain('{{');
  });

  it('substitutes every occurrence, not just the first', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { renderCoursePrompt } = await importCourse();

    const rendered = renderCoursePrompt('{{COURSE_NAME}} and {{COURSE_NAME}} again');

    expect(rendered).toBe('French III and French III again');
  });

  it('substitutes COURSE_LANGUAGE from COURSE_CONTENT.language, every occurrence', async () => {
    process.env.COURSE_NAME = 'French III';
    process.env.COURSE_TITLE = 'French III Practice & Assessment';
    vi.stubEnv('NODE_ENV', 'test');

    const { renderCoursePrompt, COURSE_CONTENT } = await importCourse();

    const rendered = renderCoursePrompt('{{COURSE_LANGUAGE}} once, {{COURSE_LANGUAGE}} twice');

    expect(rendered).toBe(`${COURSE_CONTENT.language} once, ${COURSE_CONTENT.language} twice`);
  });
});
