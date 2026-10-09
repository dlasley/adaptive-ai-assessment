/**
 * Typed-Answer Evaluation Utilities
 * Fuzzy-matching and grading for typed-answer questions (writing and fill-in-blank)
 */

import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { fetchWithRetryAfter, retryAfterSeconds } from './retry-after';

const courseFeedback = COURSE_CONTENT.feedback;

/**
 * Strip a single trailing sentence-ending mark (. ! ? or \u2026), along with any whitespace
 * immediately before it, so a terminal-punctuation-only difference never affects correctness or
 * accent comparison. Only the mark at the very end of the string is touched \u2014 an abbreviation's
 * internal period is untouched \u2014 and an answer that consists solely of the mark itself is left
 * as-is, so distinct punctuation-only answers don't collapse into a false match.
 */
function stripTerminalPunctuation(text: string): string {
  const stripped = text.replace(/\s*[.!?\u2026]$/, '');
  return stripped.length > 0 ? stripped : text;
}

/** Ligatures, folded to the two-letter form a keyboard without the ligature key produces. NFD
 * decomposition leaves them intact, so stripping diacritical marks alone does nothing to "s\u0153ur".
 * Matched after case folding, so only the lowercase forms need an entry. */
const LIGATURE_FOLDS: Record<string, string> = { '\u0153': 'oe', '\u00e6': 'ae' };
const LIGATURE_RE = /[\u0153\u00e6]/g;

/**
 * Normalize text for comparison (remove accents, fold ligatures, lowercase, trim, strip a trailing
 * sentence-ending mark)
 */
export function normalizeText(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
    .toLowerCase()
    .replace(LIGATURE_RE, (ligature) => LIGATURE_FOLDS[ligature])
    .trim()
    .replace(/\s+/g, ' '); // Normalize whitespace
  return stripTerminalPunctuation(normalized);
}

/**
 * Normalize spaces before French double punctuation (? ! ; :) for comparison.
 * In formal French typography, a space before these marks is correct.
 * This strips the space for comparison purposes only — both forms are accepted.
 */
export function normalizePunctuationSpacing(text: string): string {
  return text.replace(/\s+([?!;:])/g, '$1');
}

/**
 * Normalize whitespace, case, and French punctuation spacing while keeping accents, so "Café" and
 * "café" compare equal but "cafe" does not, and a punctuation-spacing or terminal-punctuation
 * difference is never read as an accent difference. Ligatures are kept as written, so "soeur"
 * against "sœur" still reads as a missing accent.
 *
 * Composed to NFC first: a decomposed accent (a bare vowel followed by a combining mark, which a
 * mobile keyboard can emit) carries the same accent as its precomposed form.
 */
function foldKeepingAccents(text: string): string {
  return stripTerminalPunctuation(
    normalizePunctuationSpacing(text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' '))
  );
}

/**
 * Check if accents are used correctly (case-insensitive)
 * Compares accents but ignores capitalization
 */
export function hasCorrectAccents(userAnswer: string, correctAnswer: string): boolean {
  return foldKeepingAccents(userAnswer) === foldKeepingAccents(correctAnswer);
}

/**
 * True when two strings are the same length and differ only by one pair of adjacent letters
 * exchanged ("chosiit" against "choisit"): exactly two positions differ, those positions are next
 * to each other, each holds the character the other string has, and both are letters. Equal strings
 * are not a swap, so exchanging a doubled letter ("ll") is not one either.
 *
 * Both characters have to be letters because exchanging digits or crossing a space or punctuation
 * mark produces a different answer rather than a slip: "41" is not a typo for "14", nor "jes uis"
 * for "je suis".
 */
export function isSingleAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const differing: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (differing.length === 2) return false;
    differing.push(i);
  }
  if (differing.length !== 2) return false;

  const [first, second] = differing;
  const isLetter = (char: string) => /\p{L}/u.test(char);
  return second === first + 1
    && a[first] === b[second]
    && a[second] === b[first]
    && isLetter(a[first])
    && isLetter(a[second]);
}

type MatchKind = 'exact' | 'adjacent_swap';

/** How the answer matches one candidate under the comparison normalization, or null if it doesn't. */
function matchAgainst(userAnswer: string, candidate: string): MatchKind | null {
  const user = normalizePunctuationSpacing(normalizeText(userAnswer));
  const target = normalizePunctuationSpacing(normalizeText(candidate));
  if (user === target) return 'exact';
  return isSingleAdjacentSwap(user, target) ? 'adjacent_swap' : null;
}

/**
 * Whether the answer carries the candidate's accents, judged on the same terms as the match: an
 * exact match has to agree accent for accent, a swap match has to agree once the same single
 * transposition is allowed.
 */
function accentsMatch(userAnswer: string, candidate: string, kind: MatchKind): boolean {
  if (kind === 'exact') return hasCorrectAccents(userAnswer, candidate);
  return isSingleAdjacentSwap(foldKeepingAccents(userAnswer), foldKeepingAccents(candidate));
}

/** Score for a swap match: a near-perfect answer, below both exact-match scores. */
const ADJACENT_SWAP_SCORE = 95;

/**
 * Grade a typed answer by comparison alone: accepted when, after normalization, it equals the
 * correct answer or an acceptable variation, or differs from one of them by a single adjacent-
 * character swap. Anything else returns null for the caller to grade with a model; this never
 * returns an incorrect verdict.
 *
 * Scores: 100 for an exact match on the correct answer (98 with accents missing), 98 for an exact
 * match on a variation (96 with accents missing), and 95 for a swap match against either.
 */
export function fuzzyEvaluateAnswer(
  userAnswer: string,
  correctAnswer: string | null,
  acceptableVariations: string[],
  questionType: string
): EvaluationResult | null {
  if (!correctAnswer) {
    return null;
  }

  const primaryMatch = matchAgainst(userAnswer, correctAnswer);

  if (primaryMatch === 'exact') {
    const hasAccents = accentsMatch(userAnswer, correctAnswer, 'exact');
    return {
      isCorrect: true,
      score: hasAccents ? 100 : 98,
      hasCorrectAccents: hasAccents,
      feedback: hasAccents
        ? courseFeedback.exactMatchWithAccents
        : courseFeedback.exactMatchMissingAccents,
      corrections: hasAccents ? {} : {
        accents: [courseFeedback.correctAnswerIs(correctAnswer)]
      },
      _matchInfo: {
        matchedAgainst: 'primary_answer',
        matchKind: 'exact',
        evaluationReason: 'Exact match against primary answer (after normalization)'
      }
    };
  }

  // An exact match against any variation outranks a swap against the correct answer, so every
  // variation is tried before the correct answer's swap match is used.
  const variationMatches = acceptableVariations.map((variation) => matchAgainst(userAnswer, variation));
  const exactVariationIndex = variationMatches.indexOf('exact');

  if (exactVariationIndex !== -1) {
    const variation = acceptableVariations[exactVariationIndex];
    const hasAccents = accentsMatch(userAnswer, variation, 'exact');
    return {
      isCorrect: true,
      score: hasAccents ? 98 : 96,
      hasCorrectAccents: hasAccents,
      feedback: hasAccents
        ? courseFeedback.variationExactWithAccents
        : courseFeedback.variationExactMissingAccents,
      corrections: hasAccents ? {} : {
        accents: [courseFeedback.variationCorrectIs(variation)]
      },
      _matchInfo: {
        matchedAgainst: 'acceptable_variation',
        matchedVariationIndex: exactVariationIndex,
        matchKind: 'exact',
        evaluationReason: `Exact match against acceptable variation #${exactVariationIndex + 1}`
      }
    };
  }

  if (primaryMatch === 'adjacent_swap') {
    return {
      isCorrect: true,
      score: ADJACENT_SWAP_SCORE,
      hasCorrectAccents: accentsMatch(userAnswer, correctAnswer, 'adjacent_swap'),
      feedback: courseFeedback.fuzzyMinorTypo,
      corrections: {
        suggestions: [courseFeedback.correctAnswerIs(correctAnswer)]
      },
      correctedAnswer: correctAnswer,
      _matchInfo: {
        matchedAgainst: 'primary_answer',
        matchKind: 'adjacent_swap',
        evaluationReason: 'Single adjacent-character swap against primary answer'
      }
    };
  }

  const swapVariationIndex = variationMatches.indexOf('adjacent_swap');

  if (swapVariationIndex !== -1) {
    const variation = acceptableVariations[swapVariationIndex];
    return {
      isCorrect: true,
      score: ADJACENT_SWAP_SCORE,
      hasCorrectAccents: accentsMatch(userAnswer, variation, 'adjacent_swap'),
      feedback: courseFeedback.variationCloseMatch,
      corrections: {
        suggestions: [courseFeedback.variationCorrectIs(variation)]
      },
      correctedAnswer: variation,
      _matchInfo: {
        matchedAgainst: 'acceptable_variation',
        matchedVariationIndex: swapVariationIndex,
        matchKind: 'adjacent_swap',
        evaluationReason: `Single adjacent-character swap against acceptable variation #${swapVariationIndex + 1}`
      }
    };
  }

  return null;
}

/** Stands in for a grade when the server refused to grade the answer; `retryAfterSeconds` is its Retry-After. */
export interface RateLimitedEvaluation {
  rateLimited: true;
  retryAfterSeconds: number | null;
}

export function isRateLimitedEvaluation(
  result: EvaluationResult | RateLimitedEvaluation
): result is RateLimitedEvaluation {
  return 'rateLimited' in result;
}

/**
 * Evaluate a writing answer using the API. Grading inputs (correct answer,
 * difficulty, acceptable variations) are looked up server-side from
 * questionId — this only sends what the server can't already know.
 *
 * A 429 is retried once after the server's Retry-After delay (`onBusy` runs before the wait).
 * Returns a `RateLimitedEvaluation` when the server is still rate-limiting after that: the answer
 * was not graded and must not be recorded as one.
 */
export async function evaluateWritingAnswer(
  questionId: string,
  userAnswer: string,
  onBusy?: () => void
): Promise<EvaluationResult | RateLimitedEvaluation> {
  try {
    const response = await fetchWithRetryAfter(
      '/api/evaluate-writing',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId,
          userAnswer,
        })
      },
      onBusy
    );

    if (response.status === 429) return { rateLimited: true, retryAfterSeconds: retryAfterSeconds(response) };

    if (!response.ok) {
      throw new Error('Evaluation API request failed');
    }

    const result: EvaluationResult = await response.json();
    return result;
  } catch (error) {
    console.error('Error evaluating answer:', error);

    // Fallback evaluation
    return {
      isCorrect: false,
      score: 0,
      hasCorrectAccents: false,
      feedback: courseFeedback.evaluationRequestFailed,
      corrections: {}
    };
  }
}

