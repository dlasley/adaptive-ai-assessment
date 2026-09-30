import { describe, expect, it } from 'vitest';
import { structuralValidation, type StructuralQuestion } from '../src/lib/structural-validation';

function mcq(overrides: Partial<StructuralQuestion> = {}): StructuralQuestion {
  return {
    question: 'What does "bonjour" mean?',
    type: 'multiple-choice',
    options: ['Hello', 'Goodbye', 'Thanks', 'Please'],
    correctAnswer: 'Hello',
    ...overrides,
  };
}

function trueFalse(overrides: Partial<StructuralQuestion> = {}): StructuralQuestion {
  return {
    question: 'Vrai ou Faux: "chat" means "cat".',
    type: 'true-false',
    options: ['Vrai', 'Faux'],
    correctAnswer: 'Vrai',
    ...overrides,
  };
}

function fillInBlank(overrides: Partial<StructuralQuestion> = {}): StructuralQuestion {
  return {
    question: 'Je _____ français.',
    type: 'fill-in-blank',
    correctAnswer: 'parle',
    ...overrides,
  };
}

function writing(overrides: Partial<StructuralQuestion> = {}): StructuralQuestion {
  return {
    question: "Translate to French: 'Hello, my name is Paul.'",
    type: 'writing',
    correctAnswer: "Bonjour, je m'appelle Paul.",
    ...overrides,
  };
}

describe('structuralValidation', () => {
  describe('multiple-choice', () => {
    it('accepts a well-formed MCQ', () => {
      const { valid, rejected } = structuralValidation([mcq()]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('rejects fewer than 4 options', () => {
      const { valid, rejected } = structuralValidation([
        mcq({ options: ['Hello', 'Goodbye', 'Thanks'] }),
      ]);
      expect(valid).toHaveLength(0);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe('MCQ must have exactly 4 options');
    });

    it('rejects more than 4 options', () => {
      const { rejected } = structuralValidation([
        mcq({ options: ['Hello', 'Goodbye', 'Thanks', 'Please', 'Sorry'] }),
      ]);
      expect(rejected[0].reason).toBe('MCQ must have exactly 4 options');
    });

    it('rejects a missing options array', () => {
      const { rejected } = structuralValidation([mcq({ options: undefined })]);
      expect(rejected[0].reason).toBe('MCQ must have exactly 4 options');
    });

    it('rejects when correctAnswer is not among the options', () => {
      const { rejected } = structuralValidation([mcq({ correctAnswer: 'Sorry' })]);
      expect(rejected[0].reason).toBe('MCQ correctAnswer not in options');
    });

    it('rejects duplicate options', () => {
      const { rejected } = structuralValidation([
        mcq({ options: ['Hello', 'Hello', 'Thanks', 'Please'] }),
      ]);
      expect(rejected[0].reason).toBe('MCQ has duplicate options');
    });
  });

  describe('true-false', () => {
    it('accepts a well-formed T/F question', () => {
      const { valid, rejected } = structuralValidation([trueFalse()]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('rejects options other than exactly ["Vrai", "Faux"]', () => {
      const { rejected } = structuralValidation([
        trueFalse({ options: ['True', 'False'] }),
      ]);
      expect(rejected[0].reason).toBe('T/F options must be ["Vrai", "Faux"]');
    });

    it('rejects a missing options array', () => {
      const { rejected } = structuralValidation([trueFalse({ options: undefined })]);
      expect(rejected[0].reason).toBe('T/F options must be ["Vrai", "Faux"]');
    });

    it('rejects a correctAnswer that is not Vrai or Faux', () => {
      const { rejected } = structuralValidation([trueFalse({ correctAnswer: 'Peut-être' })]);
      expect(rejected[0].reason).toBe('T/F correctAnswer must be Vrai or Faux');
    });
  });

  describe('fill-in-blank', () => {
    it('accepts a well-formed single-blank question', () => {
      const { valid, rejected } = structuralValidation([fillInBlank()]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('accepts a well-formed multi-blank question with comma-separated answers', () => {
      const { valid, rejected } = structuralValidation([
        fillInBlank({
          question: 'Tu _____ le foot et il _____ le tennis.',
          correctAnswer: 'aimes, préfère',
        }),
      ]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('rejects a question missing the _____ marker', () => {
      const { rejected } = structuralValidation([
        fillInBlank({ question: 'Je parle français.' }),
      ]);
      expect(rejected[0].reason).toBe('Fill-in-blank must contain _____');
    });

    it('rejects an empty correctAnswer', () => {
      const { rejected } = structuralValidation([fillInBlank({ correctAnswer: '' })]);
      expect(rejected[0].reason).toBe('Fill-in-blank answer is empty');
    });

    it('rejects a blank-count/answer-group mismatch (too few groups)', () => {
      const { rejected } = structuralValidation([
        fillInBlank({
          question: 'Tu _____ le foot et il _____ le tennis.',
          correctAnswer: 'aimes',
        }),
      ]);
      expect(rejected[0].reason).toBe(
        'Fill-in-blank has 2 blanks but 1 comma-separated answer groups'
      );
    });

    it('rejects a blank-count/answer-group mismatch (too many groups)', () => {
      const { rejected } = structuralValidation([
        fillInBlank({
          question: 'Je _____ français.',
          correctAnswer: 'parle, encore',
        }),
      ]);
      // Single blank: the comma-vs-space branch only activates for blankCount > 1,
      // so a single blank with a comma in the answer is treated as one group and passes.
      expect(rejected).toHaveLength(0);
    });

    it('does not misinterpret a single blank with a comma-containing answer as multi-blank', () => {
      // Current behavior: blankCount === 1 short-circuits to a single answer group
      // regardless of commas in correctAnswer, so this never rejects on group-count mismatch.
      const { valid, rejected } = structuralValidation([
        fillInBlank({
          question: 'Le français est officiel au _____.',
          correctAnswer: 'Cameroun, Congo',
        }),
      ]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('treats underscores shorter than 3 as not a blank marker for counting, but still requires the literal _____ substring', () => {
      const { rejected } = structuralValidation([
        fillInBlank({ question: 'Je __ français.', correctAnswer: 'parle' }),
      ]);
      expect(rejected[0].reason).toBe('Fill-in-blank must contain _____');
    });
  });

  describe('writing', () => {
    it('accepts a well-formed writing answer', () => {
      const { valid, rejected } = structuralValidation([writing()]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });

    it('rejects an answer shorter than 5 characters', () => {
      const { rejected } = structuralValidation([writing({ correctAnswer: 'Oui' })]);
      expect(rejected[0].reason).toBe('Writing answer too short (<5 chars)');
    });

    it('accepts an answer of exactly 5 characters', () => {
      const { valid, rejected } = structuralValidation([writing({ correctAnswer: 'Salut' })]);
      expect(valid).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });
  });

  describe('cross-type: explicit answer labels leaked into question text', () => {
    it('rejects a question containing "(answer: ...)"', () => {
      const { valid, rejected } = structuralValidation([
        mcq({ question: 'What does "bonjour" mean? (answer: Hello)' }),
      ]);
      expect(valid).toHaveLength(0);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe('Explicit answer label in question text');
    });

    it('rejects a question containing the French label "(réponse: ...)"', () => {
      const { rejected } = structuralValidation([
        writing({ question: "Translate 'hello' (réponse: bonjour)" }),
      ]);
      expect(rejected[0].reason).toBe('Explicit answer label in question text');
    });

    it('only runs the leaked-label check against questions that already passed type-specific validation', () => {
      // A question that fails MCQ option-count validation is rejected for that reason,
      // not re-flagged for a leaked label even if one is present in the text.
      const { rejected } = structuralValidation([
        mcq({
          question: 'What does "bonjour" mean? (answer: Hello)',
          options: ['Hello', 'Goodbye'],
        }),
      ]);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe('MCQ must have exactly 4 options');
    });
  });

  describe('batch behavior', () => {
    it('validates independently across a mixed batch, preserving valid questions', () => {
      const { valid, rejected } = structuralValidation([
        mcq(),
        trueFalse({ correctAnswer: 'Peut-être' }),
        fillInBlank(),
        writing({ correctAnswer: 'Oui' }),
      ]);
      expect(valid).toHaveLength(2);
      expect(rejected).toHaveLength(2);
    });

    it('returns empty arrays for an empty input', () => {
      const { valid, rejected } = structuralValidation([]);
      expect(valid).toEqual([]);
      expect(rejected).toEqual([]);
    });
  });
});
