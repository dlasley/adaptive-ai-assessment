/**
 * Tier 4 (model) grading prompt and response parsing for typed-answer questions
 * (`apps/web/src/app/api/evaluate-writing/route.ts`), extracted here so another caller can use the
 * exact prompt and parser production uses instead of a copy that can drift from it.
 *
 * The prompt text below is English-language-evaluation-generic in structure but currently names
 * "French" and French-specific typography (the space before `? ! ; :`) explicitly rather than
 * through `@adaptive/shared/course`'s `COURSE_CONTENT`/`getCourse()`. A multi-course deployment
 * would need to route those mentions through `course.ts` the way `apps/pipeline`'s audit and
 * generation prompts already do.
 */

export interface BuildEvaluationPromptParams {
  question: string;
  userAnswer: string;
  correctAnswer?: string;
  questionType: string;
  difficulty: string;
  /** Score at or above which the model should set `isCorrect: true` — the caller's
   * `CORRECTNESS_THRESHOLDS.SEMANTIC_API_PASS` equivalent, kept out of this module so it stays free
   * of any one caller's policy constants. */
  correctnessThreshold: number;
}

export function buildEvaluationPrompt(params: BuildEvaluationPromptParams): string {
  const { question, userAnswer, correctAnswer, questionType, difficulty, correctnessThreshold } = params;

  return `You are evaluating a French language student's written answer. Be thorough and pedagogical.

Question Type: ${questionType}
Difficulty Level: ${difficulty}
Question (English): "${question}"
${correctAnswer ? `Expected Answer: "${correctAnswer}"` : 'This is an open-ended question with multiple acceptable answers.'}
Student's Answer: "${userAnswer}"

Evaluate the student's answer considering:

1. **Correctness**: Is the meaning/content correct?
2. **Grammar**: Are grammar rules followed correctly?
3. **Spelling**: Are words spelled correctly (ignoring accents for now)?
4. **Accents**: Are diacritic accents used correctly? (café, été, où, etc.)
5. **Completeness**: ${questionType === 'open_ended' ? 'Is it a complete, coherent sentence/response?' : 'Does it answer the question fully?'}
6. **French Typography**: In traditional French, a space before double punctuation marks (?, !, ;, :) is correct (e.g., "français ?"). Accept BOTH forms — with or without the space. Do NOT mark the spaced version as incorrect or provide a "correctedAnswer" that removes it. Occasionally note the cultural difference in your feedback: if the student includes the space, acknowledge it positively as proper traditional French formatting; if they omit it, mention that in traditional French typography a space before ?, !, ;, : is standard — it's a good opportunity to highlight how punctuation conventions differ between metropolitan French and global French-speaking cultures.

For open-ended questions:
- Accept any grammatically correct and contextually appropriate answer
- The student's creativity should be valued
- Focus on whether they expressed their idea correctly in French

Scoring Guidelines:
- 90-100: Excellent, nearly perfect or perfect
- 80-89: Very good, minor errors
- 70-79: Good, some errors but meaning is clear
- 60-69: Acceptable, multiple errors but partially correct
- 50-59: Poor, significant errors but some correct elements
- 0-49: Incorrect or unintelligible

Confidence Assessment:
Also provide a confidence score (0-100) indicating how certain you are about this evaluation:
- 95-100: Very confident - clear-cut correct/incorrect, no ambiguity
- 85-94: Confident - standard case with clear grammar rules
- 75-84: Moderately confident - some interpretation needed
- 60-74: Uncertain - multiple valid interpretations possible
- Below 60: Low confidence - highly ambiguous or creative answer

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "isCorrect": boolean (true if score >= ${correctnessThreshold}),
  "score": number (0-100),
  "hasCorrectAccents": boolean,
  "feedback": "Brief, encouraging feedback in English (2-3 sentences)",
  "corrections": {
    "grammar": ["list of grammar corrections if needed"],
    "spelling": ["list of spelling corrections if needed"],
    "accents": ["list of words needing correct accents"],
    "suggestions": ["suggestions for improvement"]
  },
  "correctedAnswer": "The fully corrected version of their answer, or null if already perfect",
  "confidenceScore": number (0-100, your confidence in this evaluation)
}`;
}

/** The call settings the grading route uses for every Tier 4 attempt — exported so a runner
 * evaluating an alternative grading model reuses the exact same knobs rather than guessing them. */
export const GRADING_CALL_SETTINGS = {
  temperature: 0.3, // Lower temperature for consistent evaluation
  maxTokens: 4096,
  jsonMode: true,
} as const;

export interface EvaluationResponse {
  isCorrect: boolean;
  score: number;
  hasCorrectAccents: boolean;
  feedback: string;
  corrections: {
    grammar?: string[];
    spelling?: string[];
    accents?: string[];
    suggestions?: string[];
  };
  correctedAnswer?: string;
  confidenceScore?: number;
}

/** Thrown when the model's response is missing, not JSON, or missing a required field. */
export class EvaluationParseError extends Error {}

/** Checks only the fields a caller actually consumes as typed values; `corrections` and
 * `correctedAnswer` are passed through structurally and aren't worth gating on. */
function validateEvaluationResponseShape(parsed: unknown): asserts parsed is EvaluationResponse {
  const p = parsed as Partial<EvaluationResponse> | null;
  if (
    !p ||
    typeof p.isCorrect !== 'boolean' ||
    typeof p.score !== 'number' ||
    p.score < 0 ||
    p.score > 100 ||
    typeof p.feedback !== 'string'
  ) {
    throw new EvaluationParseError('evaluation response missing isCorrect/score/feedback');
  }
}

/** Strips markdown code fences (the model is asked not to use them but sometimes does anyway),
 * parses JSON, and validates the shape a caller depends on. Throws `EvaluationParseError` for any
 * failure — a caller distinguishes this from a `callLlm` failure (network, auth, rate limit),
 * which is a different class of error it handles separately. */
export function parseEvaluationResponse(text: string): EvaluationResponse {
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new EvaluationParseError('evaluation response was not valid JSON');
  }
  validateEvaluationResponseShape(parsed);
  return parsed;
}
