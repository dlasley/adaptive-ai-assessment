/**
 * Typed-Answer Evaluation Utilities
 * Fuzzy-matching and grading for typed-answer questions (writing and fill-in-blank)
 */

import { getFuzzyLogicThreshold, CORRECTNESS_THRESHOLDS } from './feature-flags';
import type { Difficulty } from '@adaptive/shared/enums';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';
import { fetchWithRetryAfter } from './retry-after';

// Not destructured to `feedback` — fuzzyEvaluateAnswer already has a local
// `feedback` variable for the string it's building up.
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

/**
 * Normalize text for comparison (remove accents, lowercase, trim, strip a trailing
 * sentence-ending mark)
 */
export function normalizeText(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
    .toLowerCase()
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
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Check if accents are used correctly (case-insensitive)
 * Compares accents but ignores capitalization
 */
export function hasCorrectAccents(userAnswer: string, correctAnswer: string): boolean {
  // Normalize whitespace, case, and French punctuation spacing, but keep accents
  // This means "Café" and "café" are both correct, but "cafe" is not
  // Also prevents a punctuation-spacing or terminal-punctuation difference from being
  // misreported as an accent issue
  const normalize = (text: string) =>
    stripTerminalPunctuation(normalizePunctuationSpacing(text.trim().toLowerCase().replace(/\s+/g, ' ')));
  return normalize(userAnswer) === normalize(correctAnswer);
}

/**
 * Calculate similarity between two strings (0-1)
 * Uses normalized Levenshtein distance
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const normalized1 = normalizePunctuationSpacing(normalizeText(str1));
  const normalized2 = normalizePunctuationSpacing(normalizeText(str2));

  const maxLength = Math.max(normalized1.length, normalized2.length);
  if (maxLength === 0) return 1.0; // Both empty = identical

  const distance = levenshteinDistance(normalized1, normalized2);
  return 1 - (distance / maxLength);
}

/**
 * Evaluate answer using fuzzy logic with confidence scoring
 * Returns null if confidence is too low (should fall back to API)
 */
export function fuzzyEvaluateAnswer(
  userAnswer: string,
  correctAnswer: string | null,
  acceptableVariations: string[],
  difficulty: Difficulty,
  questionType: string
): EvaluationResult | null {
  // Can't fuzzy evaluate open-ended questions without a correct answer
  if (!correctAnswer) {
    return null;
  }

  // Check exact match first (ignoring accents and French punctuation spacing)
  const normalizedUser = normalizePunctuationSpacing(normalizeText(userAnswer));
  const normalizedCorrect = normalizePunctuationSpacing(normalizeText(correctAnswer));

  if (normalizedUser === normalizedCorrect) {
    const hasAccents = hasCorrectAccents(userAnswer, correctAnswer);
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
        matchedSimilarity: 100, // Exact match
        evaluationReason: 'Exact match against primary answer (after normalization)'
      }
    };
  }

  // Check acceptable variations (exact match first, then similarity)
  for (let i = 0; i < acceptableVariations.length; i++) {
    const variation = acceptableVariations[i];
    const normalizedVariation = normalizePunctuationSpacing(normalizeText(variation));

    // Exact match against variation
    if (normalizedVariation === normalizedUser) {
      const hasAccents = hasCorrectAccents(userAnswer, variation);
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
          matchedVariationIndex: i,
          matchedSimilarity: 100, // Exact match
          evaluationReason: `Exact match against acceptable variation #${i + 1}`
        }
      };
    }

    // Similarity match against variation (catches typos in acceptable answers)
    const variationSimilarity = calculateSimilarity(userAnswer, variation);
    if (variationSimilarity >= 0.95) {
      const hasAccents = hasCorrectAccents(userAnswer, variation);
      return {
        isCorrect: true,
        score: Math.round(variationSimilarity * 100) - 2, // Slight penalty for not being exact
        hasCorrectAccents: hasAccents,
        feedback: courseFeedback.variationCloseMatch,
        corrections: {
          suggestions: [courseFeedback.variationCorrectIs(variation)]
        },
        correctedAnswer: variation,
        _matchInfo: {
          matchedAgainst: 'acceptable_variation',
          matchedVariationIndex: i,
          matchedSimilarity: Math.round(variationSimilarity * 100),
          evaluationReason: `Similarity match (${Math.round(variationSimilarity * 100)}%) against acceptable variation #${i + 1}`
        }
      };
    }
  }

  // Calculate similarity for fuzzy matching
  const similarity = calculateSimilarity(userAnswer, correctAnswer);
  const threshold = getFuzzyLogicThreshold(difficulty) / 100; // Convert percentage to decimal

  // If similarity is below threshold, return null (need API evaluation)
  if (similarity < threshold) {
    return null; // Low confidence - use API
  }

  // High confidence fuzzy match
  // Check if it's "close enough" based on correctness thresholds
  const similarityPercent = Math.round(similarity * 100);
  let isCorrect = false;
  let score = similarityPercent;
  let feedback = '';
  let correctnessBand = '';

  if (similarityPercent >= CORRECTNESS_THRESHOLDS.MINOR_TYPO) {
    // Very close - probably a minor typo
    isCorrect = true;
    feedback = courseFeedback.fuzzyMinorTypo;
    correctnessBand = `${CORRECTNESS_THRESHOLDS.MINOR_TYPO}%+ (minor typo)`;
  } else if (similarityPercent >= CORRECTNESS_THRESHOLDS.BEGINNER_PASS) {
    // Close - some errors but recognizable
    isCorrect = difficulty === 'beginner'; // Only count as correct for beginners
    feedback = isCorrect
      ? courseFeedback.fuzzyBeginnerPass
      : courseFeedback.fuzzyBeginnerPassIneligible;
    correctnessBand = `${CORRECTNESS_THRESHOLDS.BEGINNER_PASS}-${CORRECTNESS_THRESHOLDS.MINOR_TYPO - 1}% (beginner pass only)`;
  } else {
    // Below beginner pass threshold
    isCorrect = false;
    feedback = courseFeedback.fuzzyBelowThreshold;
    correctnessBand = `below ${CORRECTNESS_THRESHOLDS.BEGINNER_PASS}% (incorrect)`;
  }

  const hasAccents = hasCorrectAccents(userAnswer, correctAnswer);

  return {
    isCorrect,
    score,
    hasCorrectAccents: hasAccents,
    feedback,
    corrections: {
      suggestions: [courseFeedback.correctAnswerIs(correctAnswer)]
    },
    correctedAnswer: correctAnswer,
    _matchInfo: {
      matchedAgainst: 'primary_answer',
      matchedSimilarity: similarityPercent,
      evaluationReason: `Fuzzy match against primary answer (${similarityPercent}% similarity)`,
      correctnessBand
    }
  };
}

/**
 * Evaluate a writing answer using the API. Grading inputs (correct answer,
 * difficulty, acceptable variations) are looked up server-side from
 * questionId — this only sends what the server can't already know.
 *
 * A 429 is retried once after the server's Retry-After delay (`onBusy` runs before the wait).
 * Returns null when the server is still rate-limiting after that: the answer was not graded and
 * must not be recorded as one.
 */
export async function evaluateWritingAnswer(
  questionId: string,
  userAnswer: string,
  onBusy?: () => void
): Promise<EvaluationResult | null> {
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

    if (response.status === 429) return null;

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

