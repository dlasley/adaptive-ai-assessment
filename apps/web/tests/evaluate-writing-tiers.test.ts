import { describe, expect, it } from 'vitest';
import { exactMatchTier, fuzzyTier, isNoiseAnswer, noiseCheckTier, type TierContext } from '@/lib/evaluate-writing/tiers';

/** A single adjacent-character swap ("Bonjuor" for "Bonjour"), which Tier 3 accepts, so it does not
 * reach the exact-match tier or fall through to the semantic tier. */
function fuzzyMatchContext(overrides: Partial<TierContext> = {}): TierContext {
  return {
    userAnswer: 'Bonjuor',
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
      evaluationTier: 'fuzzy_match',
      matchedAgainst: 'primary_answer',
      matchKind: 'adjacent_swap',
    });
  });

  it('reports the grading path whether or not the session is a superuser', () => {
    expect(fuzzyTier(fuzzyMatchContext({ includeSuperuserMetadata: false }))?.gradedBy).toBe('swap');
    expect(fuzzyTier(fuzzyMatchContext({ includeSuperuserMetadata: true }))?.gradedBy).toBe('swap');
  });

  it('reports a variation match separately from a match against the correct answer', () => {
    const exactVariation = fuzzyTier(
      fuzzyMatchContext({ userAnswer: 'Salut', acceptableVariations: ['Salut'] })
    );
    const swappedVariation = fuzzyTier(
      fuzzyMatchContext({ userAnswer: 'Saltu', acceptableVariations: ['Salut'] })
    );

    expect(exactVariation?.gradedBy).toBe('variation');
    expect(swappedVariation?.gradedBy).toBe('variation_swap');
  });

  it('grades the same answer the same way at every difficulty', () => {
    const results = (['beginner', 'intermediate', 'advanced'] as const).map((difficulty) =>
      fuzzyTier(fuzzyMatchContext({ difficulty }))
    );

    expect(results.map((r) => r?.isCorrect)).toEqual([true, true, true]);
    expect(results.map((r) => r?.score)).toEqual([95, 95, 95]);
  });

  it('falls through to the semantic tier for a one-letter substitution, at every difficulty', () => {
    for (const difficulty of ['beginner', 'intermediate', 'advanced'] as const) {
      expect(
        fuzzyTier(
          fuzzyMatchContext({
            difficulty,
            userAnswer: 'Amadou et Chloé sont soif.',
            correctAnswer: 'Amadou et Chloé ont soif.',
          })
        )
      ).toBeNull();
    }
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
    expect(result!.gradedBy).toBe('exact');
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

    expect(noiseCheckTier(base)).toMatchObject({ isCorrect: false, score: 0, gradedBy: 'noise' });
    expect(noiseCheckTier(base)?.metadata).toBeUndefined();
    expect(noiseCheckTier({ ...base, includeSuperuserMetadata: true })?.metadata?.evaluationTier).toBe('noise_check');
  });

  it('returns null for an answer that is text', () => {
    expect(noiseCheckTier(fuzzyMatchContext())).toBeNull();
  });
});
