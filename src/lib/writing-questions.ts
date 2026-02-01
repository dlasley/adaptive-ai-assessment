/**
 * Writing Questions Utilities
 * Functions for French writing questions with typed answers
 */

import { supabase, isSupabaseAvailable } from './supabase';
import type { EvaluationResult } from '@/app/api/evaluate-writing/route';

export interface WritingQuestion {
  id: string;
  question_en: string;
  correct_answer_fr: string | null;
  acceptable_variations: string[];
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  question_type: 'translation' | 'conjugation' | 'open_ended' | 'question_formation' | 'sentence_building';
  explanation: string;
  hints: string[];
  unit_id: string | null;
  requires_complete_sentence: boolean;
  created_at: string;
}

export interface WritingAttempt {
  id: string;
  study_code_id: string;
  question_id: string;
  user_answer: string;
  is_correct: boolean;
  score: number;
  has_correct_accents: boolean | null;
  feedback: string | null;
  corrections: any;
  attempted_at: string;
  evaluation_model: string;
}

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
 * Check if two answers match exactly (with accents)
 */
export function exactMatch(answer1: string, answer2: string): boolean {
  return answer1.trim().toLowerCase() === answer2.trim().toLowerCase();
}

/**
 * Check if two answers match (ignoring accents)
 */
export function normalizedMatch(answer1: string, answer2: string): boolean {
  return normalizeText(answer1) === normalizeText(answer2);
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
  // Normalize whitespace and case, but keep accents
  // This means "Café" and "café" are both correct, but "cafe" is not
  const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalize(userAnswer) === normalize(correctAnswer);
}

/**
 * Confidence thresholds for fuzzy evaluation
 * Higher difficulty = higher confidence required before using fuzzy logic
 */
const CONFIDENCE_THRESHOLDS = {
  beginner: 0.95,      // 95% confidence (raised to prevent accepting semantically wrong answers)
  intermediate: 0.85,  // 85% confidence
  advanced: 0.95,      // 95% confidence
} as const;

/**
 * Calculate similarity between two strings (0-1)
 * Uses normalized Levenshtein distance
 */
export function calculateSimilarity(str1: string, str2: string): number {
  const normalized1 = normalizeText(str1);
  const normalized2 = normalizeText(str2);

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

  // Check exact match first (ignoring accents)
  const normalizedUser = normalizeText(userAnswer);
  const normalizedCorrect = normalizeText(correctAnswer);

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
      }
    };
  }

  // Check acceptable variations
  for (const variation of acceptableVariations) {
    if (normalizeText(variation) === normalizedUser) {
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
        }
      };
    }
  }

  // Calculate similarity for fuzzy matching
  const similarity = calculateSimilarity(userAnswer, correctAnswer);
  const threshold = CONFIDENCE_THRESHOLDS[difficulty];

  // If similarity is below threshold, return null (need API evaluation)
  if (similarity < threshold) {
    return null; // Low confidence - use API
  }

  // High confidence fuzzy match
  // Check if it's "close enough" based on difficulty
  let isCorrect = false;
  let score = 0;
  let feedback = '';

  if (similarity >= 0.95) {
    // Very close - probably a minor typo
    isCorrect = true;
    score = Math.round(similarity * 100);
    feedback = 'Presque parfait ! Attention aux petites erreurs.';
  } else if (similarity >= 0.85) {
    // Close - some errors but recognizable
    isCorrect = difficulty === 'beginner'; // Only count as correct for beginners
    score = Math.round(similarity * 100);
    feedback = isCorrect
      ? 'Bon effort ! Quelques petites erreurs à corriger.'
      : 'Pas mal, mais il y a des erreurs à corriger.';
  } else if (similarity >= 0.70) {
    // Moderate similarity - has the right idea
    isCorrect = false;
    score = Math.round(similarity * 100);
    feedback = 'Vous êtes sur la bonne voie, mais il y a plusieurs erreurs.';
  } else {
    // Below threshold - should not reach here but handle anyway
    return null;
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
    correctedAnswer: correctAnswer
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
  studyCodeId?: string
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
        studyCodeId
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

/**
 * Save a writing attempt to the database
 */
export async function saveWritingAttempt(
  studyCodeId: string,
  questionId: string,
  userAnswer: string,
  evaluation: EvaluationResult
): Promise<boolean> {
  if (!isSupabaseAvailable()) return false;

  try {
    const { error } = await supabase!
      .from('writing_question_attempts')
      .insert({
        study_code_id: studyCodeId,
        question_id: questionId,
        user_answer: userAnswer,
        is_correct: evaluation.isCorrect,
        score: evaluation.score,
        has_correct_accents: evaluation.hasCorrectAccents,
        feedback: evaluation.feedback,
        corrections: evaluation.corrections
      });

    if (error) {
      console.error('Error saving writing attempt:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to save writing attempt:', error);
    return false;
  }
}

/**
 * Get writing questions by difficulty
 */
export async function getWritingQuestions(
  difficulty?: string,
  limit = 10
): Promise<WritingQuestion[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    let query = supabase!
      .from('writing_questions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (difficulty) {
      query = query.eq('difficulty', difficulty);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching writing questions:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to get writing questions:', error);
    return [];
  }
}

/**
 * Get random writing questions for practice
 */
export async function getRandomWritingQuestions(
  count: number = 5,
  difficulty?: 'beginner' | 'intermediate' | 'advanced'
): Promise<WritingQuestion[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    // Build query with random ordering
    let query = supabase!
      .from('writing_questions')
      .select('*');

    if (difficulty) {
      query = query.eq('difficulty', difficulty);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching random questions:', error);
      return [];
    }

    if (!data || data.length === 0) return [];

    // Shuffle and return requested count
    const shuffled = [...data].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  } catch (error) {
    console.error('Failed to get random questions:', error);
    return [];
  }
}

/**
 * Get a student's writing attempts
 */
export async function getStudentWritingAttempts(
  studyCodeId: string,
  limit = 20
): Promise<WritingAttempt[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    const { data, error } = await supabase!
      .from('writing_question_attempts')
      .select('*')
      .eq('study_code_id', studyCodeId)
      .order('attempted_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching writing attempts:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to get writing attempts:', error);
    return [];
  }
}

/**
 * Generate new writing questions via API
 */
export async function generateWritingQuestions(
  count = 20,
  difficulty?: string,
  topic?: string
): Promise<WritingQuestion[]> {
  try {
    const response = await fetch('/api/generate-writing-questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, difficulty, topic })
    });

    if (!response.ok) {
      throw new Error('Question generation API request failed');
    }

    const result = await response.json();
    return result.questions || [];
  } catch (error) {
    console.error('Error generating questions:', error);
    return [];
  }
}
