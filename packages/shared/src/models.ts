/**
 * OpenRouter model slugs for each pipeline stage and API route.
 */

export const MODELS = {
  pdfConversion: 'anthropic/claude-sonnet-5',
  /** Teaching-content classifier that gates each slide before its transcription call. A
   * different vendor from the transcriber, chosen for matching the course owner's slide rulings at
   * a fraction of a cent per slide. */
  slideContentClassifier: 'google/gemini-3.1-flash-lite',
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

/**
 * Per-model sampling constraints a caller must respect: `fixedTemperature` means the model rejects
 * any request that sends a `temperature` other than its own fixed default, so a caller must omit
 * the field entirely rather than send one; `reasoningRequired` means the model rejects a request
 * that disables reasoning outright (`{ enabled: false }`), so a caller that would otherwise disable
 * it must send the lowest effort tier that still counts as enabled instead. System configuration,
 * not derived from any registry row. `eval-run` is the only consumer today
 * (`apps/pipeline/src/lib/eval/tasks/shared.ts`'s `resolveEffectiveSamplingSettings`); production
 * callers (pdf conversion, audit, grading) are unaffected and keep sending their own settings as
 * written.
 */
export const MODEL_CONSTRAINTS: Record<string, { fixedTemperature?: true; reasoningRequired?: true }> = {
  'anthropic/claude-sonnet-5.5': { fixedTemperature: true, reasoningRequired: true },
};
