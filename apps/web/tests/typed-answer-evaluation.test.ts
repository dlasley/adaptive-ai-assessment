import { describe, expect, it } from 'vitest';
import {
  calculateSimilarity,
  fuzzyEvaluateAnswer,
  hasCorrectAccents,
  normalizePunctuationSpacing,
  normalizeText,
} from '@/lib/typed-answer-evaluation';
import { COURSE_CONTENT } from '@adaptive/shared/course';

const { feedback: courseFeedback } = COURSE_CONTENT;

describe('normalizeText', () => {
  it('strips a single trailing period', () => {
    expect(normalizeText('Nous allons à la plage.')).toBe(normalizeText('Nous allons à la plage'));
  });

  it('strips a single trailing exclamation or question mark', () => {
    expect(normalizeText('Bonjour!')).toBe(normalizeText('Bonjour'));
    expect(normalizeText('Comment ça va?')).toBe(normalizeText('Comment ça va'));
  });

  it('strips a single trailing ellipsis', () => {
    expect(normalizeText('Attendez…')).toBe(normalizeText('Attendez'));
  });

  it('does not strip an internal period (abbreviation), only a trailing one', () => {
    expect(normalizeText('M. Dupont')).not.toBe(normalizeText('M Dupont'));
    expect(normalizeText('M. Dupont')).toBe(normalizeText('m. dupont'));
  });

  it('does not collapse a punctuation-only answer to an empty string', () => {
    expect(normalizeText('.')).toBe('.');
    expect(normalizeText('!')).not.toBe(normalizeText('.'));
  });
});

describe('normalizePunctuationSpacing', () => {
  it('strips a space before French double punctuation (? ! ; :)', () => {
    expect(normalizePunctuationSpacing('Comment allez-vous ?')).toBe('Comment allez-vous?');
    expect(normalizePunctuationSpacing("C'est vrai !")).toBe("C'est vrai!");
    expect(normalizePunctuationSpacing('Bonjour ; au revoir')).toBe('Bonjour; au revoir');
    expect(normalizePunctuationSpacing('Titre :')).toBe('Titre:');
  });

  it('leaves text without a preceding space unchanged', () => {
    expect(normalizePunctuationSpacing('Comment allez-vous?')).toBe('Comment allez-vous?');
  });

  it('collapses multiple spaces before the punctuation mark', () => {
    expect(normalizePunctuationSpacing('Vraiment   ?')).toBe('Vraiment?');
  });
});

describe('hasCorrectAccents', () => {
  it('treats accented and unaccented forms as different (accents matter)', () => {
    expect(hasCorrectAccents('cafe', 'café')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasCorrectAccents('Café', 'café')).toBe(true);
  });

  it('ignores whitespace differences', () => {
    expect(hasCorrectAccents('  café  ', 'café')).toBe(true);
  });

  it('does not misreport a punctuation-spacing-only difference as an accent issue', () => {
    // "café ?" vs "café?" differ only in the space before "?" — normalizePunctuationSpacing
    // strips that space before comparison, so this must not read as an accent mismatch.
    expect(hasCorrectAccents('café ?', 'café?')).toBe(true);
  });

  it('still detects a real accent difference alongside punctuation spacing', () => {
    expect(hasCorrectAccents('cafe ?', 'café?')).toBe(false);
  });

  it('does not misreport a trailing-period-only difference as an accent issue', () => {
    expect(hasCorrectAccents('Nous allons à la plage', 'Nous allons à la plage.')).toBe(true);
  });

  it('handles trailing ! and ? the same way', () => {
    expect(hasCorrectAccents('Salut', 'Salut!')).toBe(true);
    expect(hasCorrectAccents('Ça va', 'Ça va?')).toBe(true);
  });

  it('still detects a real accent difference when a trailing period also differs', () => {
    expect(hasCorrectAccents('Nous allons a la plage.', 'Nous allons à la plage.')).toBe(false);
  });

  it('does not strip an internal period (abbreviation)', () => {
    expect(hasCorrectAccents('M. Dupont est là', 'M Dupont est là')).toBe(false);
  });
});

describe('calculateSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(calculateSimilarity('bonjour', 'bonjour')).toBe(1);
  });

  it('returns 1.0 when both strings are empty', () => {
    expect(calculateSimilarity('', '')).toBe(1);
  });

  it('is insensitive to accents and case (normalized before comparison)', () => {
    expect(calculateSimilarity('Café', 'cafe')).toBe(1);
  });

  it('is insensitive to punctuation spacing', () => {
    expect(calculateSimilarity('bonjour ?', 'bonjour?')).toBe(1);
  });

  it('returns a value between 0 and 1 for partially similar strings', () => {
    const sim = calculateSimilarity('bonjour', 'bonjoir');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('returns a low similarity for completely different strings', () => {
    const sim = calculateSimilarity('bonjour', 'xyz');
    expect(sim).toBeLessThan(0.5);
  });
});

describe('fuzzyEvaluateAnswer', () => {
  const difficulty = 'intermediate' as const;

  it('returns null immediately when correctAnswer is null (open-ended question)', () => {
    const result = fuzzyEvaluateAnswer('anything', null, [], difficulty, 'writing');
    expect(result).toBeNull();
  });

  it('returns a perfect exact match with correct accents', () => {
    const result = fuzzyEvaluateAnswer('café', 'café', [], difficulty, 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
    expect(result!._matchInfo?.matchedAgainst).toBe('primary_answer');
    expect(result!._matchInfo?.matchedSimilarity).toBe(100);
  });

  it('treats a trailing-period-only difference as an exact match, not a fuzzy one', () => {
    // Regression: previously fell through to the general similarity branch instead of the
    // internal exact-match check above, scoring 96% ("Presque parfait") and misreporting a
    // correct-accent answer as an accent mismatch.
    const result = fuzzyEvaluateAnswer('Nous allons à la plage', 'Nous allons à la plage.', [], difficulty, 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
    expect(result!._matchInfo?.matchedSimilarity).toBe(100);
    expect(result!._matchInfo?.evaluationReason).toContain('Exact match');
  });

  it('accepts an exact match missing accents, scored slightly lower', () => {
    const result = fuzzyEvaluateAnswer('cafe', 'café', [], difficulty, 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!.hasCorrectAccents).toBe(false);
    expect(result!.corrections.accents).toBeDefined();
    expect(result!.feedback).toBe(courseFeedback.exactMatchMissingAccents);
    expect(result!.corrections.accents).toEqual([courseFeedback.correctAnswerIs('café')]);
  });

  it('matches an acceptable variation exactly', () => {
    const result = fuzzyEvaluateAnswer(
      'Bonjour, je m\'appelle Paul.',
      'Salut, je m\'appelle Paul.',
      ["Bonjour, je m'appelle Paul."],
      difficulty,
      'writing'
    );
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!._matchInfo?.matchedAgainst).toBe('acceptable_variation');
    expect(result!._matchInfo?.matchedVariationIndex).toBe(0);
    expect(result!.feedback).toBe(courseFeedback.variationExactWithAccents);
  });

  it('matches an acceptable variation via similarity (>=95%) when not exact', () => {
    // Missing comma is a 1-character diff on a 53-char string — 98% similarity, above the 95% bar.
    const userAnswer = "Je voudrais du cafe et un croissant s'il vous plait";
    const variation = "Je voudrais du cafe et un croissant, s'il vous plait";
    const result = fuzzyEvaluateAnswer(userAnswer, 'no match at all', [variation], difficulty, 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!._matchInfo?.matchedAgainst).toBe('acceptable_variation');
    expect(result!.correctedAnswer).toBe(variation);
    expect(result!.feedback).toBe(courseFeedback.variationCloseMatch);
    expect(result!.corrections.suggestions).toEqual([courseFeedback.variationCorrectIs(variation)]);
  });

  it('returns null (defers to API) when similarity is below the difficulty threshold', () => {
    // intermediate fuzzy-logic threshold is 85% — a wildly different answer falls below it.
    const result = fuzzyEvaluateAnswer('xyz complete nonsense', 'Je mange une pomme.', [], difficulty, 'writing');
    expect(result).toBeNull();
  });

  it('classifies >=95% similarity as MINOR_TYPO and correct', () => {
    // "advanced" has a 95% fuzzy-logic threshold, so only near-exact matches reach the banding logic.
    const result = fuzzyEvaluateAnswer('Nous allons au marche ensemble', 'Nous allons au march ensemble', [], 'advanced', 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!._matchInfo?.evaluationReason).toContain('Fuzzy match');
  });

  it('classifies 85-94% similarity as correct for a beginner', () => {
    const result = fuzzyEvaluateAnswer('Je mage une pome', 'Je mange une pomme', [], 'beginner', 'fill-in-blank');
    const sim = calculateSimilarity('Je mage une pome', 'Je mange une pomme');
    expect(sim * 100).toBeGreaterThanOrEqual(85);
    expect(sim * 100).toBeLessThan(95);
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
  });

  it('classifies 85-94% similarity as incorrect for a non-beginner', () => {
    const result = fuzzyEvaluateAnswer('Je mage une pome', 'Je mange une pomme', [], 'intermediate', 'fill-in-blank');
    const sim = calculateSimilarity('Je mage une pome', 'Je mange une pomme');
    expect(sim * 100).toBeGreaterThanOrEqual(85);
    expect(sim * 100).toBeLessThan(95);
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(false);
  });

  it('classifies below-BEGINNER_PASS similarity (but above the fuzzy threshold) as incorrect', () => {
    // beginner fuzzy-logic threshold is 70%, BEGINNER_PASS band starts at 85% —
    // an answer in between reaches the banding logic but fails every band.
    const result = fuzzyEvaluateAnswer('Je mag un pom', 'Je mange une pomme', [], 'beginner', 'fill-in-blank');
    const sim = calculateSimilarity('Je mag un pom', 'Je mange une pomme');
    expect(sim * 100).toBeGreaterThanOrEqual(70);
    expect(sim * 100).toBeLessThan(85);
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(false);
    expect(result!._matchInfo?.correctnessBand).toContain('incorrect');
    expect(result!.feedback).toBe(courseFeedback.fuzzyBelowThreshold);
  });
});
