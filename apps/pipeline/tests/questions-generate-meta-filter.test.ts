import { describe, expect, it } from 'vitest';
import { isMetaQuestion, GENERATION_ONLY_META_PATTERNS } from '../src/commands/questions-generate';
import { META_QUESTION_PATTERNS, matchMetaQuestionPattern } from '@adaptive/shared/meta-question-filter';

/**
 * Generation's filter must be a strict superset of the shared serving-time filter: everything the
 * shared core catches, generation must also catch, plus the generation-only patterns layered on
 * top (teacher bio, pedagogical tips, classroom retrospection, course structure, material
 * meta-references).
 */

function question(text: string) {
  return {
    id: 'q1',
    question: text,
    type: 'multiple-choice' as const,
    correctAnswer: 'A',
    unitId: 'unit-1',
    topic: 'greetings',
    difficulty: 'beginner' as const,
  };
}

// One sample sentence per shared-core rule, matched against its own pattern to keep this fixture
// honest if the shared patterns ever change.
const SHARED_CORE_SAMPLES: Record<string, string> = {
  'mistakes-should-not-discourage': 'Remember that making mistakes shouldn\'t discourage you.',
  'language-acquisition-is-a-journey': 'Language acquisition is a personal journey for every student.',
  'growth-mindset': 'Having a growth mindset helps you learn faster.',
  'willingness-to-learn': 'Willingness to learn matters more than talent.',
  'part-of-learning-process': 'Mistakes are a natural part of the learning process.',
  'most-important-factor-for-success': 'What is the most important factor in language learning success?',
  'effort-key-to-language-success': 'Effort plays a key role in language learning.',
  'practice-is-key-to-success': 'Practice is the key to language success.',
  'consistency-is-key': 'Consistency is the key to learning.',
  'language-learning-emphasized': 'Language learning should be emphasized every day.',
};

describe('isMetaQuestion is a superset of the shared meta-question filter', () => {
  it('covers every shared-core rule via its own sample sentence', () => {
    for (const { rule } of META_QUESTION_PATTERNS) {
      expect(SHARED_CORE_SAMPLES).toHaveProperty(rule);
    }
  });

  it.each(Object.entries(SHARED_CORE_SAMPLES))('flags the shared-core sample for %s', (rule, text) => {
    expect(matchMetaQuestionPattern(text)?.rule).toBe(rule);
    expect(isMetaQuestion(question(text))).toBe(true);
  });

  it('also flags generation-only patterns the shared core does not cover', () => {
    const teacherBioText = 'Mme. Dupont has lived in Paris for ten years.';

    expect(matchMetaQuestionPattern(teacherBioText)).toBeUndefined();
    expect(isMetaQuestion(question(teacherBioText))).toBe(true);
  });

  it('layers distinct generation-only rules on top of the shared core, not duplicates of it', () => {
    const sharedRules = new Set(META_QUESTION_PATTERNS.map((p) => p.rule));
    for (const { rule } of GENERATION_ONLY_META_PATTERNS) {
      expect(sharedRules.has(rule)).toBe(false);
    }
  });

  it('does not flag a legitimate question that merely mentions "practice" or "consistency"', () => {
    expect(isMetaQuestion(question('Complete the sentence: "La pratique rend parfait." What does "pratique" mean?'))).toBe(false);
    expect(isMetaQuestion(question('Which verb form is used consistently across all "-er" verbs in the present tense?'))).toBe(false);
  });
});
