import { describe, expect, it } from 'vitest';
import { matchMetaQuestionPattern } from '../src/meta-question-filter';

describe('matchMetaQuestionPattern', () => {
  it('matches a generator-artifact meta-question and reports its rule', () => {
    const matched = matchMetaQuestionPattern('What is the most important factor in language learning success?');

    expect(matched?.rule).toBe('most-important-factor-for-success');
  });

  it('matches against the explanation text as well as the question text', () => {
    const matched = matchMetaQuestionPattern(
      'Complete the sentence.',
      'Remember, consistency is the key to learning a language well.'
    );

    expect(matched?.rule).toBe('consistency-is-key');
  });

  it('does not flag a legitimate question that merely mentions "practice" or "consistency"', () => {
    expect(
      matchMetaQuestionPattern('Complete the sentence: "La pratique rend parfait." What does "pratique" mean?')
    ).toBeUndefined();
    expect(
      matchMetaQuestionPattern('Which verb form is used consistently across all "-er" verbs in the present tense?')
    ).toBeUndefined();
  });

  it('returns undefined for a question with no explanation and no match', () => {
    expect(matchMetaQuestionPattern('Conjugate "parler" in the present tense for "nous".')).toBeUndefined();
  });
});
