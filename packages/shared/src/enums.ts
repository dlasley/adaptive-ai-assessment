/**
 * Canonical value sets for `questions.difficulty`, `questions.type`, and
 * `questions.writing_type`. These mirror the CHECK constraints in
 * supabase/schema.sql; every TypeScript union type, CLI flag validation list,
 * or iteration over "all valid values" for these three columns should import
 * from here rather than redeclaring the values. tests/enums.test.ts parses
 * schema.sql's CHECK constraints and fails if this file drifts from them.
 */

export const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

export const QUESTION_TYPES = ['multiple-choice', 'true-false', 'fill-in-blank', 'writing'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const WRITING_TYPES = [
  'translation',
  'conjugation',
  'open_ended',
  'question_formation',
  'sentence_building',
] as const;
export type WritingType = (typeof WRITING_TYPES)[number];
