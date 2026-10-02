/**
 * Single source of truth for which course this deployment serves.
 *
 * The app title, header, and every question-generation and audit prompt derive
 * from this file. The display name and title come from server-side env vars
 * (COURSE_NAME, COURSE_TITLE). Switching the deployment to a new course's
 * branding means setting those two env vars; switching its curriculum scope (`level` below)
 * or grading feedback (`feedback` below) means editing this file — nothing
 * else in `apps/web/`, `apps/pipeline/`, or `packages/shared/` should
 * hard-code a course name, title, level, or grading feedback message.
 *
 * `getCourse()` reads and validates COURSE_NAME/COURSE_TITLE the first time it's called, and
 * memoizes the result for the rest of the process — not at module import. A caller that only needs
 * this module for something else (an unrelated export, or a static analysis tool reading its
 * shape) never reads an env file as a side effect of importing it; only actually calling
 * `getCourse()` (or `renderCoursePrompt()`, which calls it) does.
 *
 * `COURSE_CONTENT` holds everything about the course that doesn't come from an env var —
 * icon, language, curriculum level, and grading feedback text. It's a plain object with no env
 * access anywhere in its definition, so client components and client-bundled library code (e.g.
 * answer evaluation) can import it directly for feedback/language strings without pulling in the
 * env-reading code path that `getCourse()` sits on top of.
 */

export interface CourseLevel {
  /** Inline clause for prompts, e.g. "a second-year French course (French II) at a US high school". */
  description: string;
  /** What students already know coming into this course, for prompts that draw on prior-year material. */
  priorKnowledge: string;
  /** Grammar and vocabulary newly in scope this year — the ceiling for "advanced" difficulty. */
  scope: string;
  /** Grammar reserved for a later course. Never require these, even at "advanced" difficulty. */
  outOfScope: string[];
}

export interface CourseFeedback {
  /** Typed answer shorter than the minimum length the evaluator will score. */
  answerTooShort: string;
  /** Suggestion accompanying answerTooShort. */
  answerTooShortSuggestion: string;
  /** Exact match against the primary answer, accents included. */
  exactMatchWithAccents: string;
  /** Exact match against the primary answer, accents missing or wrong. */
  exactMatchMissingAccents: string;
  /** Correction shown alongside exactMatchMissingAccents and the fuzzy-match primary-answer correction. */
  correctAnswerIs: (answer: string) => string;
  /** Exact match against an acceptable variation, accents included. */
  variationExactWithAccents: string;
  /** Exact match against an acceptable variation, accents missing or wrong. */
  variationExactMissingAccents: string;
  /** Correction shown alongside variationExactMissingAccents and variationCloseMatch. */
  variationCorrectIs: (variation: string) => string;
  /** Similarity match (>=95%) against an acceptable variation, not exact. */
  variationCloseMatch: string;
  /** Fuzzy match at or above the minor-typo similarity band. */
  fuzzyMinorTypo: string;
  /** Fuzzy match in the beginner-pass band, for a beginner-difficulty question. */
  fuzzyBeginnerPass: string;
  /** Fuzzy match in the beginner-pass band, for a non-beginner-difficulty question (counted incorrect). */
  fuzzyBeginnerPassIneligible: string;
  /** Fuzzy match below the beginner-pass band. */
  fuzzyBelowThreshold: string;
  /** Client-side fallback when the evaluation request itself fails (network error). English, not
   * the target language — an operational error message for the student, not grading feedback on
   * their answer, unlike every other string in this interface. */
  evaluationRequestFailed: string;
  /** Server-side fallback when the AI evaluation call fails. English for the same reason as
   * evaluationRequestFailed. */
  evaluationApiFailed: string;
  /** Server-side fallback when the day's allowance of AI evaluations is spent. English for the
   * same reason as evaluationRequestFailed. */
  evaluationDailyLimit: string;
}

export interface Course {
  /** Display name, e.g. "French II". Read from COURSE_NAME. */
  name: string;
  /** Full app title — browser tab and header text. Read from COURSE_TITLE. */
  title: string;
  /** The language being taught, e.g. "French" — for UI copy that names the subject generically. */
  language: string;
  level: CourseLevel;
  feedback: CourseFeedback;
}

// Fallback for local development, tests, and local `next build` runs without a
// configured environment. Any Vercel build or deployment (VERCEL_ENV set) and
// any production server must set COURSE_NAME and COURSE_TITLE: static pages are
// rendered at build time, so a missing value has to fail the build rather than
// bake the fallback into them.
const DEV_DEFAULT_NAME = 'French II';
const DEV_DEFAULT_TITLE = 'French II Practice & Assessment';

// Next.js sets NEXT_PHASE to this value for the whole `next build` process,
// including prerendering, which evaluates this module.
const NEXT_BUILD_PHASE = 'phase-production-build';

function readCourseEnv(varName: 'COURSE_NAME' | 'COURSE_TITLE', devDefault: string): string {
  const value = process.env[varName];
  if (value) return value;

  const isVercel = Boolean(process.env.VERCEL_ENV);
  const isProductionServer =
    process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== NEXT_BUILD_PHASE;
  if (isVercel || isProductionServer) {
    throw new Error(`${varName} is not set. Configure it in the deployment environment.`);
  }

  return devDefault;
}

/**
 * The parts of the course that don't depend on COURSE_NAME/COURSE_TITLE: the display icon,
 * language identity, and grading feedback copy. A plain object with no env access, so it's safe
 * for client bundles to import directly (see the module doc comment above).
 */
export const COURSE_CONTENT: {
  /** Shown beside the course title in the header. Omitted entirely (not just blank) when unset. */
  icon?: string;
  language: string;
  /** The language's name in itself, e.g. "Français" — for UI copy written in the student's target language. */
  nativeLanguageName: string;
  /** Accented or special characters a student needs to type, for keyboard tips. */
  specialCharacters: string[];
  feedback: CourseFeedback;
} = {
  icon: '🇫🇷',
  language: 'French',
  nativeLanguageName: 'Français',
  specialCharacters: ['é', 'è', 'ê'],
  feedback: {
    answerTooShort: 'Réponse trop courte. Veuillez fournir une réponse complète.',
    answerTooShortSuggestion: "Essayez d'écrire une réponse complète en français.",
    exactMatchWithAccents: 'Parfait ! Réponse correcte avec les accents appropriés.',
    exactMatchMissingAccents: 'Correct ! Attention aux accents pour être parfait.',
    correctAnswerIs: (answer) => `La réponse correcte est: "${answer}"`,
    variationExactWithAccents: "Très bien ! C'est une variation acceptable.",
    variationExactMissingAccents: 'Bien ! Attention aux accents. Variation acceptable.',
    variationCorrectIs: (variation) => `Une variation correcte est: "${variation}"`,
    variationCloseMatch: 'Presque parfait ! Petite erreur dans une variation acceptable.',
    fuzzyMinorTypo: 'Presque parfait ! Attention aux petites erreurs.',
    fuzzyBeginnerPass: 'Bon effort ! Quelques petites erreurs à corriger.',
    fuzzyBeginnerPassIneligible: 'Pas mal, mais il y a des erreurs à corriger.',
    fuzzyBelowThreshold: 'Vous êtes sur la bonne voie, mais il y a plusieurs erreurs.',
    evaluationRequestFailed: 'Unable to evaluate. Please try again.',
    evaluationApiFailed: 'Unable to evaluate automatically. Please try again or ask your teacher for feedback.',
    evaluationDailyLimit: 'The automatic grader is unavailable right now. Ask your teacher for feedback on this answer.',
  },
};

function buildCourse(): Course {
  const name = readCourseEnv('COURSE_NAME', DEV_DEFAULT_NAME);
  const title = readCourseEnv('COURSE_TITLE', DEV_DEFAULT_TITLE);

  return {
    name,
    title,
    language: COURSE_CONTENT.language,
    level: {
      description: `a second-year French course (${name}) at a US high school`,
      priorKnowledge:
        "students completed French I: present tense of regular -er/-ir/-re verbs and common irregulars (être, avoir, aller, faire), basic articles and partitives, adjective agreement, aller + infinitive for near future, avoir expressions (avoir faim, avoir froid, etc.), and core greetings, numbers, and classroom vocabulary",
      scope:
        "the passé composé and imparfait (including choosing between them), the futur simple, direct and indirect object pronouns, reflexive/pronominal verbs, comparatives and superlatives, y and en, and negation beyond ne...pas (ne...jamais, ne...rien, ne...personne, ne...plus)",
      outOfScope: [
        'the subjunctive',
        'the conditional',
        'the passé simple or other literary tenses',
        'complex relative pronouns beyond basic qui/que/où',
      ],
    },
    feedback: COURSE_CONTENT.feedback,
  };
}

let cachedCourse: Course | undefined;

/**
 * Returns this deployment's course identity, reading and validating COURSE_NAME/COURSE_TITLE on
 * first call. Memoized after a successful read, so a later env change has no effect within the same
 * process. A failed read (missing env vars in a context that requires them) is not cached, so a
 * retry after fixing the environment succeeds normally.
 */
export function getCourse(): Course {
  if (!cachedCourse) {
    cachedCourse = buildCourse();
  }
  return cachedCourse;
}

/**
 * Substitutes `{{COURSE_NAME}}`, `{{COURSE_LEVEL}}`, and `{{COURSE_LANGUAGE}}` placeholders in a
 * prompt template loaded from apps/pipeline/prompts/*.md.
 */
export function renderCoursePrompt(template: string): string {
  const course = getCourse();
  return template
    .replaceAll('{{COURSE_NAME}}', course.name)
    .replaceAll('{{COURSE_LEVEL}}', course.level.description)
    .replaceAll('{{COURSE_LANGUAGE}}', course.language);
}
