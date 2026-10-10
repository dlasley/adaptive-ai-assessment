import type { GradedBy } from '@adaptive/shared/enums';

/** The grading paths the evaluate route tries, in order. */
export type EvaluationTierName = 'empty_check' | 'exact_match' | 'fuzzy_match' | 'noise_check' | 'semantic';

export interface EvaluationResult {
  isCorrect: boolean;
  score: number; // 0-100
  hasCorrectAccents: boolean;
  feedback: string;
  corrections: {
    grammar?: string[];
    spelling?: string[];
    accents?: string[];
    suggestions?: string[];
  };
  correctedAnswer?: string;
  /** Which grading path settled the answer, stored as `question_results.graded_by`. Every result
   * the evaluate route returns carries it; the client's own local grades (multiple choice and
   * true-false, and the fallback used when the grading request fails) leave it unset. */
  gradedBy?: GradedBy;
  // Internal field for passing match info from fuzzy evaluation (removed before sending response)
  _matchInfo?: {
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number;
    matchKind?: 'exact' | 'adjacent_swap'; // How the answer matched what it was compared against
    evaluationReason: string;
  };
  // Superuser metadata (only included when is_superuser=true)
  metadata?: {
    difficulty: string;
    evaluationTier: EvaluationTierName;
    matchKind?: 'exact' | 'adjacent_swap'; // How the answer matched (exact_match and fuzzy_match tiers)
    modelConfidence?: number; // 0-100, the model's self-reported confidence (only for the semantic tier)
    usedSemanticTier: boolean;
    modelUsed?: string;
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number; // Which variation was matched (0-indexed)
    evaluationReason: string; // Human-readable explanation of why this tier was used
  };
}
