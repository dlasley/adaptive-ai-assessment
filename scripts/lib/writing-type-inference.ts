/**
 * Writing Type Inference
 * Pattern-based inference of writing question subtypes from question text
 *
 * Types: translation, conjugation, question_formation, sentence_building, open_ended
 */

export type WritingType =
  | 'translation'
  | 'conjugation'
  | 'question_formation'
  | 'sentence_building'
  | 'open_ended';

/**
 * Pattern definitions for each writing type
 * Patterns are tested in order; first match wins
 * open_ended is the fallback (no pattern needed)
 */
const WRITING_TYPE_PATTERNS: Record<Exclude<WritingType, 'open_ended'>, RegExp> = {
  translation: /translate|en français|in french|into french|tradui/i,
  conjugation: /conjugat|verb form|present tense form|all six.*forms/i,
  question_formation: /write a question|create a question|form a question|turn.+into.+question|using.+est-ce que/i,
  sentence_building: /write.+sentence|create.+sentence|complete.+sentence|combine.+sentence|using the (words|following|structure)|rewrite|write.+(two|three|four|five|six).+sentence/i,
};

/**
 * Order of pattern matching (most specific first)
 * open_ended is always last (fallback)
 */
const PATTERN_ORDER: Exclude<WritingType, 'open_ended'>[] = [
  'conjugation',        // Most specific patterns
  'question_formation', // Specific to question creation
  'sentence_building',  // Broader sentence construction
  'translation',        // Most common, check after others
];

/**
 * Infer the writing type from question text using pattern matching
 * @param questionText The question text to analyze
 * @returns The inferred WritingType
 */
export function inferWritingType(questionText: string): WritingType {
  const text = questionText.toLowerCase();

  for (const type of PATTERN_ORDER) {
    if (WRITING_TYPE_PATTERNS[type].test(text)) {
      return type;
    }
  }

  // Default to open_ended for dialogue, describe, and other creative tasks
  return 'open_ended';
}

