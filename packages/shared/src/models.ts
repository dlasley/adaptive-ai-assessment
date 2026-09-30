/**
 * OpenRouter model slugs for each pipeline stage and API route.
 */

export const MODELS = {
  pdfConversion: 'anthropic/claude-sonnet-5',
  topicExtraction: 'anthropic/claude-sonnet-5',
  topicSimilarity: 'anthropic/claude-haiku-4.5',
  /** MCQ and true-false generation (structured types with fixed answer sets) */
  questionGenerationStructured: 'anthropic/claude-haiku-4.5',
  /** Fill-in-blank and writing generation (typed answers requiring higher accuracy) */
  questionGenerationTyped: 'anthropic/claude-sonnet-5',
  /** Post-generation answer validation + acceptable variation generation */
  answerValidation: 'anthropic/claude-sonnet-5',
  /** Default synchronous Stage 3 auditor: Mistral Large 3. */
  mistralAudit: 'mistralai/mistral-large-2512',
  /** Stage 3 auditor for --llm-batch mode: Mistral Large 3, the same model as the sync auditor. */
  mistralAuditBatch: 'mistralai/mistral-large-2512',
  /** Sonnet audit (available via --auditor sonnet) */
  sonnetAudit: 'anthropic/claude-sonnet-5',
  /** Writing evaluation (`/api/evaluate-writing`) */
  writingEvaluation: 'anthropic/claude-opus-5.5',
};
