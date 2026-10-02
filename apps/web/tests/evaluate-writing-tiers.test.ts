import { describe, expect, it } from 'vitest';
import { exactMatchTier, fuzzyTier, isNoiseAnswer, noiseCheckTier, type TierContext } from '@/lib/evaluate-writing/tiers';

/** A near-miss ("Bonjor" vs "Bonjour") that's close enough to clear the beginner fuzzy-logic
 * threshold (70%) and the beginner-pass correctness band (85%+), so it resolves at Tier 3
 * without reaching the exact-match tier or falling through to the Semantic API. */
function fuzzyMatchContext(overrides: Partial<TierContext> = {}): TierContext {
  return {
    userAnswer: 'Bonjor',
    correctAnswer: 'Bonjour',
    difficulty: 'beginner',
    acceptableVariations: [],
    questionType: 'writing',
    includeSuperuserMetadata: false,
    ...overrides,
  };
}

describe('fuzzyTier', () => {
  it('never includes _matchInfo or any other internal field for a non-superuser match', () => {
    const result = fuzzyTier(fuzzyMatchContext({ includeSuperuserMetadata: false }));

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('_matchInfo');
    expect(result?.metadata).toBeUndefined();
    expect(Object.keys(result!).every((key) => !key.startsWith('_'))).toBe(true);
  });

  it('keeps the derived metadata, without the internal field, for a superuser match', () => {
    const result = fuzzyTier(fuzzyMatchContext({ includeSuperuserMetadata: true }));

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('_matchInfo');
    expect(result?.metadata).toMatchObject({
      evaluationTier: 'fuzzy_logic',
      matchedAgainst: 'primary_answer',
    });
  });
});

describe('exactMatchTier', () => {
  const baseCtx: TierContext = {
    userAnswer: '',
    correctAnswer: '',
    difficulty: 'beginner',
    acceptableVariations: [],
    questionType: 'writing',
    includeSuperuserMetadata: true,
  };

  it('resolves a trailing-period-only difference at this tier, not the fuzzy tier', () => {
    const result = exactMatchTier({
      ...baseCtx,
      userAnswer: 'Nous allons à la plage',
      correctAnswer: 'Nous allons à la plage.',
    });

    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
    expect(result!.metadata?.evaluationTier).toBe('exact_match');
  });

  it('still flags a real missing accent when a trailing period also differs', () => {
    const result = exactMatchTier({
      ...baseCtx,
      userAnswer: 'Nous allons a la plage.',
      correctAnswer: 'Nous allons à la plage.',
    });

    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!.hasCorrectAccents).toBe(false);
  });
});

describe('isNoiseAnswer', () => {
  it.each(['?!?!', '   ', '...', '{}', '你好', '[[[[[[[[[[[[[[[[[[[[[[a]]]]]]]]]]]]]]]]]]]]]]'])(
    'flags %j',
    (answer) => {
      expect(isNoiseAnswer(answer)).toBe(true);
    }
  );

  it.each([
    'Bonjour',
    "Je m'appelle Paul.",
    'A-t-il ?',
    "Qu'est-ce que c'est ?",
    "L'été, c'est l'été !",
    'Où est la bibliothèque ?',
    'Élève',
    '15',
    '1998',
    '12345',
  ])('passes the French answer %j on to the later tiers', (answer) => {
    expect(isNoiseAnswer(answer)).toBe(false);
  });
});

describe('noiseCheckTier', () => {
  it('scores noise 0 with the too-short feedback and no model call, and adds metadata only for a superuser', () => {
    const base = { ...fuzzyMatchContext(), userAnswer: '{}{}{}' };

    expect(noiseCheckTier(base)).toMatchObject({ isCorrect: false, score: 0 });
    expect(noiseCheckTier(base)?.metadata).toBeUndefined();
    expect(noiseCheckTier({ ...base, includeSuperuserMetadata: true })?.metadata?.evaluationTier).toBe('noise_check');
  });

  it('returns null for an answer that is text', () => {
    expect(noiseCheckTier(fuzzyMatchContext())).toBeNull();
  });
});
