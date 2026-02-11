/**
 * Writing Questions Utilities
 * Functions for French writing questions with typed answers
 */

import { getFuzzyLogicThreshold, CORRECTNESS_THRESHOLDS } from './feature-flags';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';

/**
 * Normalize text for comparison (remove accents, lowercase, trim)
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritical marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' '); // Normalize whitespace
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
export function levenshteinDistance(str1: string, str2: string): number {
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
  // Also prevents a punctuation space difference from being misreported as an accent issue
  const normalize = (text: string) => normalizePunctuationSpacing(text.trim().toLowerCase().replace(/\s+/g, ' '));
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
  difficulty: 'beginner' | 'intermediate' | 'advanced',
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
        ? 'Parfait ! Réponse correcte avec les accents appropriés.'
        : 'Correct ! Attention aux accents pour être parfait.',
      corrections: hasAccents ? {} : {
        accents: [`La réponse correcte est: "${correctAnswer}"`]
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
          ? 'Très bien ! C\'est une variation acceptable.'
          : 'Bien ! Attention aux accents. Variation acceptable.',
        corrections: hasAccents ? {} : {
          accents: [`Une variation correcte est: "${variation}"`]
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
        feedback: 'Presque parfait ! Petite erreur dans une variation acceptable.',
        corrections: {
          suggestions: [`Une variation correcte est: "${variation}"`]
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
    feedback = 'Presque parfait ! Attention aux petites erreurs.';
    correctnessBand = `${CORRECTNESS_THRESHOLDS.MINOR_TYPO}%+ (minor typo)`;
  } else if (similarityPercent >= CORRECTNESS_THRESHOLDS.BEGINNER_PASS) {
    // Close - some errors but recognizable
    isCorrect = difficulty === 'beginner'; // Only count as correct for beginners
    feedback = isCorrect
      ? 'Bon effort ! Quelques petites erreurs à corriger.'
      : 'Pas mal, mais il y a des erreurs à corriger.';
    correctnessBand = `${CORRECTNESS_THRESHOLDS.BEGINNER_PASS}-${CORRECTNESS_THRESHOLDS.MINOR_TYPO - 1}% (beginner pass only)`;
  } else {
    // Below beginner pass threshold
    isCorrect = false;
    feedback = 'Vous êtes sur la bonne voie, mais il y a plusieurs erreurs.';
    correctnessBand = `below ${CORRECTNESS_THRESHOLDS.BEGINNER_PASS}% (incorrect)`;
  }

  const hasAccents = hasCorrectAccents(userAnswer, correctAnswer);

  return {
    isCorrect,
    score,
    hasCorrectAccents: hasAccents,
    feedback,
    corrections: {
      suggestions: [`La réponse correcte est: "${correctAnswer}"`]
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
 * Evaluate a writing answer using the API
 */
export async function evaluateWritingAnswer(
  question: string,
  userAnswer: string,
  correctAnswer: string | null,
  questionType: string,
  difficulty: string,
  acceptableVariations: string[] = [],
  studyCodeId?: string,
  superuserOverride?: boolean | null
): Promise<EvaluationResult> {
  try {
    const response = await fetch('/api/evaluate-writing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        userAnswer,
        correctAnswer,
        questionType,
        difficulty,
        acceptableVariations,
        studyCodeId,
        superuserOverride
      })
    });

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
      feedback: 'Unable to evaluate. Please try again.',
      corrections: {}
    };
  }
}

