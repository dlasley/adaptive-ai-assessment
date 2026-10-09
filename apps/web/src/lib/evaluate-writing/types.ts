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
    matchKind?: 'exact' | 'adjacent_swap'; // How the answer matched what it was compared against
    evaluationReason: string;
  };
  // Superuser metadata (only included when is_superuser=true)
  metadata?: {
    difficulty: string;
    evaluationTier: 'empty_check' | 'exact_match' | 'fuzzy_logic' | 'noise_check' | 'claude_api';
    matchKind?: 'exact' | 'adjacent_swap'; // How the answer matched (exact_match and fuzzy_logic tiers)
    modelConfidence?: number; // 0-100, the model's self-reported confidence (only for claude_api tier)
    usedClaudeAPI: boolean;
    modelUsed?: string;
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number; // Which variation was matched (0-indexed)
    evaluationReason: string; // Human-readable explanation of why this tier was used
  };
}
