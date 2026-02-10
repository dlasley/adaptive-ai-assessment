/**
 * Centralized configuration for pipeline scripts.
 */

export const MODELS = {
  pdfConversion: 'claude-sonnet-4-20250514',
  topicExtraction: 'claude-sonnet-4-20250514',
  topicSimilarity: 'claude-haiku-4-5-20251001',
  questionGeneration: 'claude-haiku-4-5-20251001',
};

/** Estimated cost per Haiku 4.5 API call (~3k input + 1.5k output tokens) */
export const COST_PER_API_CALL = 0.008;
