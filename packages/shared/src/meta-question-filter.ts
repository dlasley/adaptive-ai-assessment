/**
 * Generator-artifact phrasings that identify a meta-question about learning philosophy,
 * motivation, or personal teacher information rather than actual course content. Each pattern is
 * anchored to the specific sentence shape the generator produces for that phrasing, not to an
 * isolated keyword — a question can legitimately discuss "practice", "consistency", or "language
 * acquisition" as vocabulary without being a meta-question about them.
 *
 * Shared between the pipeline's generation-time filter and the app's serving-time filter so the
 * two never drift apart; each caller does its own logging around `matchMetaQuestionPattern`.
 */
export interface MetaQuestionPattern {
  pattern: RegExp;
  rule: string;
}

export const META_QUESTION_PATTERNS: MetaQuestionPattern[] = [
  { pattern: /making mistakes.*(should not|shouldn't) discourage you/i, rule: 'mistakes-should-not-discourage' },
  { pattern: /language acquisition is (a |an )?(personal|lifelong|individual) (journey|process)/i, rule: 'language-acquisition-is-a-journey' },
  { pattern: /(having|maintaining|with) a growth mindset (is|helps|will help)/i, rule: 'growth-mindset' },
  { pattern: /willingness to learn (is|matters|plays)/i, rule: 'willingness-to-learn' },
  { pattern: /(is|are) (a |an )?(natural|important|normal) part of the (language )?learning process/i, rule: 'part-of-learning-process' },
  { pattern: /what is the most important factor (in|for) (language )?learning success/i, rule: 'most-important-factor-for-success' },
  { pattern: /effort (is|plays).*(key|essential|crucial) (role|factor) in language (learning|acquisition)/i, rule: 'effort-key-to-language-success' },
  { pattern: /practice is the key to (language )?success/i, rule: 'practice-is-key-to-success' },
  { pattern: /consistency is (the )?key to (language )?(learning|success)/i, rule: 'consistency-is-key' },
  { pattern: /language learning (should be|is) emphasized/i, rule: 'language-learning-emphasized' },
];

/**
 * Returns the first matched pattern for a question's text, or `undefined` if none match. Checks
 * the question and explanation text independently so a match in either flags the question.
 */
export function matchMetaQuestionPattern(
  questionText: string,
  explanationText?: string | null
): MetaQuestionPattern | undefined {
  const question = questionText.toLowerCase();
  const explanation = (explanationText || '').toLowerCase();

  return META_QUESTION_PATTERNS.find(({ pattern }) => pattern.test(question) || pattern.test(explanation));
}
