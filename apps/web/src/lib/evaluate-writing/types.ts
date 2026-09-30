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
  // Internal field for passing match info from fuzzy evaluation (removed before sending response)
  _matchInfo?: {
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number;
    matchedSimilarity?: number; // 0-100, similarity to the matched answer (not necessarily primary)
    evaluationReason: string;
    correctnessBand?: string; // Which correctness band this fell into (e.g., "95%+ (minor typo)")
  };
  // Superuser metadata (only included when is_superuser=true)
  metadata?: {
    difficulty: string;
    evaluationTier: 'empty_check' | 'exact_match' | 'fuzzy_logic' | 'claude_api';
    levenshteinSimilarity?: number; // 0-100, similarity score from Levenshtein distance
    levenshteinThreshold?: number; // 0-100, threshold for this difficulty
    modelConfidence?: number; // 0-100, the model's self-reported confidence (only for claude_api tier)
    usedClaudeAPI: boolean;
    modelUsed?: string;
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number; // Which variation was matched (0-indexed)
    evaluationReason: string; // Human-readable explanation of why this tier was used
    correctnessBand?: string; // Which correctness band this fell into (for fuzzy_logic tier)
  };
}
