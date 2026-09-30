/**
 * Grading reference seed generation for `eval-seed-grading`: two label classes (typo, missing_accent)
 * are computed deterministically from the correct answer rather than asked of a model — a model
 * asked to "introduce one typo" is unreliable about the "one character" part, and diacritic
 * stripping is exactly mechanical. The remaining four label classes go through the model, one call
 * per question covering every one of them still missing an answer.
 */

import { GRADING_LABEL_CLASSES, POLICY_LABEL_CLASSES, type GradingLabelClass } from './set-builder';

export const DETERMINISTIC_LABEL_CLASSES = POLICY_LABEL_CLASSES;
export const MODEL_SEEDED_LABEL_CLASSES = GRADING_LABEL_CLASSES.filter(
  (c): c is Exclude<GradingLabelClass, (typeof DETERMINISTIC_LABEL_CLASSES)[number]> =>
    !(DETERMINISTIC_LABEL_CLASSES as readonly string[]).includes(c),
);

// Combining marks (U+0300-U+036F) render as a floating accent with no base character, which makes
// them unreadable and easy to mistype as a literal regex character class — built from code points
// instead, which stays plain ASCII in source.
const COMBINING_MARKS_RE = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g');

/** Ligatures NFD normalization has no canonical decomposition for, expanded to the two-letter form
 * a keyboard without the ligature key would produce — the same "dropped accent" a real student
 * types. Uppercase forms included since a correct answer can start a sentence. */
const LIGATURE_EXPANSIONS: Record<string, string> = { œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE' };
const LIGATURE_RE = /[œŒæÆ]/g;

/**
 * Strips combining diacritical marks, preserving case and everything else — "café" -> "cafe".
 * Ligatures are expanded first (see `LIGATURE_EXPANSIONS`), since NFD normalization alone leaves
 * them untouched and stripping marks after would do nothing to "œuf" or "sœur".
 */
export function stripAccents(text: string): string {
  const expanded = text.replace(LIGATURE_RE, (ch) => LIGATURE_EXPANSIONS[ch]);
  return expanded.normalize('NFD').replace(COMBINING_MARKS_RE, '');
}

/**
 * A one-character transposition near the middle of the answer — a mechanical stand-in for "a
 * one-character slip on a correct answer". Swaps two adjacent characters rather than deleting or
 * substituting one, so the result stays the same length and visibly close to the original.
 *
 * Never returns `correctAnswer` unchanged: a doubled letter at the preferred swap position (e.g.
 * "assez") would otherwise silently produce the original string, since swapping two identical
 * characters is a no-op. Searches outward from the preferred position for the first adjacent pair
 * that actually differs; returns undefined when none exists (every adjacent pair identical, e.g.
 * "aa", or fewer than two characters) rather than fabricating a fake typo.
 */
export function computeTypoAnswer(correctAnswer: string): string | undefined {
  const chars = [...correctAnswer];
  if (chars.length < 2) return undefined;

  // Only two different letters inside one word count as a typo a student would make: swapping
  // across a space or punctuation, or swapping digits, produces a different answer, not a slip.
  const isLetter = (c: string) => /\p{L}/u.test(c);
  const eligible = chars.slice(0, -1).map((_, i) => i).filter((i) => isLetter(chars[i]) && isLetter(chars[i + 1]) && chars[i] !== chars[i + 1]);
  if (eligible.length === 0) return undefined;

  const preferredIndex = Math.floor(chars.length / 2) - 1;
  const i = eligible.reduce((best, idx) => (Math.abs(idx - preferredIndex) < Math.abs(best - preferredIndex) ? idx : best), eligible[0]);
  const swapped = [...chars];
  [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
  return swapped.join('');
}

/** What `computeDeterministicAnswer` found for one (label class, correct answer) pair. */
export type DeterministicSeedResult =
  | { kind: 'answer'; value: string }
  /** The label class is deterministic, but no valid transform exists for this correct answer
   * (e.g. `computeTypoAnswer` on a word with every character identical). The caller should reject
   * the item rather than write a degenerate one. */
  | { kind: 'rejected'; reason: string }
  /** Not one of the deterministic label classes — needs a model call. */
  | { kind: 'not-deterministic' };

/** Computes the deterministic answer for `typo`/`missing_accent`, or reports that a label class
 * needs a model call instead. */
export function computeDeterministicAnswer(labelClass: GradingLabelClass, correctAnswer: string): DeterministicSeedResult {
  if (labelClass === 'typo') {
    const typo = computeTypoAnswer(correctAnswer);
    return typo !== undefined
      ? { kind: 'answer', value: typo }
      : { kind: 'rejected', reason: `no adjacent-character swap changes '${correctAnswer}'` };
  }
  if (labelClass === 'missing_accent') {
    const stripped = stripAccents(correctAnswer);
    return stripped !== correctAnswer
      ? { kind: 'answer', value: stripped }
      : { kind: 'rejected', reason: `'${correctAnswer}' has no accent to strip` };
  }
  return { kind: 'not-deterministic' };
}

export interface SeedPromptParams {
  questionType: string;
  difficulty: string;
  question: string;
  correctAnswer: string;
  /** Which of MODEL_SEEDED_LABEL_CLASSES to ask for in this call — a re-run only needs to fill in
   * the label classes still missing a submitted_answer. */
  labelClasses: GradingLabelClass[];
}

/** Substitutes this prompt's own placeholders (question/answer/category fields), distinct from
 * `renderCoursePrompt`'s `{{COURSE_NAME}}`/`{{COURSE_LEVEL}}`, which a caller applies first. */
export function renderSeedGradingPrompt(template: string, params: SeedPromptParams): string {
  return template
    .replaceAll('{{QUESTION_TYPE}}', params.questionType)
    .replaceAll('{{DIFFICULTY}}', params.difficulty)
    .replaceAll('{{QUESTION}}', params.question)
    .replaceAll('{{CORRECT_ANSWER}}', params.correctAnswer)
    .replaceAll('{{LABEL_CLASSES}}', params.labelClasses.join(', '));
}

export class SeedGradingParseError extends Error {}

/** Parses the model's JSON object of {labelClass: answer}, requiring every requested label class
 * to be present as a non-empty string. Throws `SeedGradingParseError` on any failure — the caller
 * leaves those items' submitted_answer empty for a later re-run rather than writing a partial or
 * fabricated result. */
export function parseSeedGradingResponse(text: string, labelClasses: GradingLabelClass[]): Record<string, string> {
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new SeedGradingParseError('seed response was not valid JSON');
  }
  const record = parsed as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    throw new SeedGradingParseError('seed response was not a JSON object');
  }
  const result: Record<string, string> = {};
  for (const labelClass of labelClasses) {
    const value = record[labelClass];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new SeedGradingParseError(`seed response missing a non-empty answer for '${labelClass}'`);
    }
    result[labelClass] = value;
  }
  return result;
}
