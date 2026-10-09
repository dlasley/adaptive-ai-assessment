import { describe, expect, it } from 'vitest';
import {
  fuzzyEvaluateAnswer,
  hasCorrectAccents,
  isSingleAdjacentSwap,
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

  it('folds the œ and æ ligatures to their two-letter forms, in both cases', () => {
    expect(normalizeText('sœur')).toBe('soeur');
    expect(normalizeText('Œuf')).toBe('oeuf');
    expect(normalizeText('curriculum vitæ')).toBe('curriculum vitae');
    expect(normalizeText('Æsop')).toBe('aesop');
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

  it('treats a decomposed accent as the accent it renders as', () => {
    const decomposed = 'café'; // "café" written as e + combining acute
    expect(decomposed).not.toBe('café');
    expect(hasCorrectAccents(decomposed, 'café')).toBe(true);
  });

  it('treats a ligature written as two letters as a missing accent', () => {
    expect(hasCorrectAccents('soeur', 'sœur')).toBe(false);
  });
});

describe('isSingleAdjacentSwap', () => {
  it('accepts one pair of adjacent characters exchanged', () => {
    expect(isSingleAdjacentSwap('chosiit', 'choisit')).toBe(true);
    expect(isSingleAdjacentSwap('setp, douze', 'sept, douze')).toBe(true);
  });

  it('rejects equal strings, so exchanging a doubled letter is not a swap', () => {
    expect(isSingleAdjacentSwap('elle', 'elle')).toBe(false);
  });

  it('rejects a substitution', () => {
    expect(isSingleAdjacentSwap('chas', 'chat')).toBe(false);
    expect(isSingleAdjacentSwap('bonjoir', 'bonjour')).toBe(false);
  });

  it('rejects two adjacent substitutions that are not an exchange of each other\'s characters', () => {
    // 'ab' to 'cd': the differing positions are adjacent, but neither holds the character
    // the other position has, so this is a double substitution, not a swap.
    expect(isSingleAdjacentSwap('ab', 'cd')).toBe(false);
  });

  it('rejects a different length (a dropped or added letter)', () => {
    expect(isSingleAdjacentSwap('bonjor', 'bonjour')).toBe(false);
    expect(isSingleAdjacentSwap('bonjourr', 'bonjour')).toBe(false);
  });

  it('rejects a different length even when the shorter string, read alone, looks like a swap of the longer one\'s start', () => {
    // The first two characters of 'bac' read as 'a' and 'b' swapped against 'ab', but 'bac' carries
    // a trailing character 'ab' doesn't have, so this is a length difference, not a swap.
    expect(isSingleAdjacentSwap('ab', 'bac')).toBe(false);
  });

  it('rejects two swaps', () => {
    expect(isSingleAdjacentSwap('ohcisit', 'choisit')).toBe(false);
  });

  it('rejects a non-adjacent exchange', () => {
    expect(isSingleAdjacentSwap('tac', 'cat')).toBe(false);
  });

  // The seeder's typo definition (apps/pipeline/src/lib/eval/grading-seed.ts) excludes these for
  // the same reason: they produce a different answer rather than a slip.
  it('rejects a swap of two digits', () => {
    expect(isSingleAdjacentSwap('41', '14')).toBe(false);
    expect(isSingleAdjacentSwap('le 41 juillet', 'le 14 juillet')).toBe(false);
  });

  it('rejects a swap across a space', () => {
    expect(isSingleAdjacentSwap('jes uis', 'je suis')).toBe(false);
  });

  it('rejects a swap of a letter with punctuation', () => {
    expect(isSingleAdjacentSwap('le ,la', 'le, la')).toBe(false);
  });

  it('still accepts a swap of two letters next to a space or digit', () => {
    expect(isSingleAdjacentSwap('setp, douze', 'sept, douze')).toBe(true);
    expect(isSingleAdjacentSwap('le 14 jiullet', 'le 14 juillet')).toBe(true);
  });
});

describe('fuzzyEvaluateAnswer', () => {
  it('returns null immediately when correctAnswer is null (open-ended question)', () => {
    const result = fuzzyEvaluateAnswer('anything', null, [], 'writing');
    expect(result).toBeNull();
  });

  it('returns a perfect exact match with correct accents', () => {
    const result = fuzzyEvaluateAnswer('café', 'café', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
    expect(result!._matchInfo?.matchedAgainst).toBe('primary_answer');
    expect(result!._matchInfo?.matchKind).toBe('exact');
  });

  it('treats a trailing-period-only difference as an exact match', () => {
    const result = fuzzyEvaluateAnswer('Nous allons à la plage', 'Nous allons à la plage.', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
    expect(result!._matchInfo?.matchKind).toBe('exact');
    expect(result!._matchInfo?.evaluationReason).toContain('Exact match');
  });

  it('accepts an exact match missing accents, scored slightly lower', () => {
    const result = fuzzyEvaluateAnswer('cafe', 'café', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!.hasCorrectAccents).toBe(false);
    expect(result!.feedback).toBe(courseFeedback.exactMatchMissingAccents);
    expect(result!.corrections.accents).toEqual([courseFeedback.correctAnswerIs('café')]);
  });

  it('matches an acceptable variation exactly', () => {
    const result = fuzzyEvaluateAnswer(
      'Bonjour, je m\'appelle Paul.',
      'Salut, je m\'appelle Paul.',
      ["Bonjour, je m'appelle Paul."],
      'writing'
    );
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!._matchInfo?.matchedAgainst).toBe('acceptable_variation');
    expect(result!._matchInfo?.matchedVariationIndex).toBe(0);
    expect(result!._matchInfo?.matchKind).toBe('exact');
    expect(result!.feedback).toBe(courseFeedback.variationExactWithAccents);
  });

  it('accepts a single adjacent swap against the correct answer', () => {
    const result = fuzzyEvaluateAnswer('Il chosiit', 'Il choisit', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(95);
    expect(result!.feedback).toBe(courseFeedback.fuzzyMinorTypo);
    expect(result!.correctedAnswer).toBe('Il choisit');
    expect(result!.corrections.suggestions).toEqual([courseFeedback.correctAnswerIs('Il choisit')]);
    expect(result!._matchInfo?.matchedAgainst).toBe('primary_answer');
    expect(result!._matchInfo?.matchKind).toBe('adjacent_swap');
  });

  it('accepts a single adjacent swap against an acceptable variation, with its index', () => {
    const result = fuzzyEvaluateAnswer(
      'Il chosiit',
      'Elle décide',
      ['Elle choisit', 'Il choisit'],
      'writing'
    );
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(95);
    expect(result!.feedback).toBe(courseFeedback.variationCloseMatch);
    expect(result!.correctedAnswer).toBe('Il choisit');
    expect(result!._matchInfo?.matchedAgainst).toBe('acceptable_variation');
    expect(result!._matchInfo?.matchedVariationIndex).toBe(1);
    expect(result!._matchInfo?.matchKind).toBe('adjacent_swap');
  });

  it('accepts a swap inside one blank of a two-blank answer', () => {
    const result = fuzzyEvaluateAnswer('setp, douze', 'sept, douze', [], 'fill-in-blank');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(95);
    expect(result!._matchInfo?.matchKind).toBe('adjacent_swap');
  });

  it('accepts a swap in an accented answer and keeps the accents correct', () => {
    const result = fuzzyEvaluateAnswer('Il préfère le hté', 'Il préfère le thé', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(95);
    expect(result!.hasCorrectAccents).toBe(true);
  });

  it('accepts a ligature written as two letters, reported as missing accents', () => {
    const result = fuzzyEvaluateAnswer('soeur', 'sœur', [], 'fill-in-blank');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.score).toBe(98);
    expect(result!.hasCorrectAccents).toBe(false);
    expect(result!._matchInfo?.matchKind).toBe('exact');
    expect(result!.corrections.accents).toEqual([courseFeedback.correctAnswerIs('sœur')]);
  });

  it('scores a decomposed accent as a perfect match', () => {
    const result = fuzzyEvaluateAnswer('café', 'café', [], 'fill-in-blank');
    expect(result).not.toBeNull();
    expect(result!.score).toBe(100);
    expect(result!.hasCorrectAccents).toBe(true);
  });

  it('returns null for a swap of two digits', () => {
    expect(fuzzyEvaluateAnswer('41', '14', [], 'fill-in-blank')).toBeNull();
    expect(fuzzyEvaluateAnswer('le 41 juillet', 'le 14 juillet', [], 'fill-in-blank')).toBeNull();
  });

  it('returns null for a swap across a space or punctuation mark', () => {
    expect(fuzzyEvaluateAnswer('jes uis', 'je suis', [], 'writing')).toBeNull();
    expect(fuzzyEvaluateAnswer('le ,la', 'le, la', [], 'fill-in-blank')).toBeNull();
  });

  it('reports missing accents on a swap match when the accent is absent', () => {
    // "ecoutze" is "écoutez" with the last two letters exchanged and the accent dropped.
    const result = fuzzyEvaluateAnswer('ecoutze', 'écoutez', [], 'writing');
    expect(result).not.toBeNull();
    expect(result!.isCorrect).toBe(true);
    expect(result!.hasCorrectAccents).toBe(false);
    expect(result!._matchInfo?.matchKind).toBe('adjacent_swap');
  });

  it('returns null for a single substitution', () => {
    expect(fuzzyEvaluateAnswer('Amadou et Chloé sont soif.', 'Amadou et Chloé ont soif.', [], 'writing')).toBeNull();
    expect(fuzzyEvaluateAnswer('bonjoir', 'bonjour', [], 'writing')).toBeNull();
  });

  it('returns null for a dropped letter', () => {
    expect(fuzzyEvaluateAnswer('Bonjor', 'Bonjour', [], 'writing')).toBeNull();
  });

  it('returns null for two swaps', () => {
    expect(fuzzyEvaluateAnswer('Il ohcisit', 'Il choisit', [], 'writing')).toBeNull();
  });

  it('returns null for an unrelated answer', () => {
    expect(fuzzyEvaluateAnswer('xyz complete nonsense', 'Je mange une pomme.', [], 'writing')).toBeNull();
  });

  it('returns null for a one-letter difference in a long sentence', () => {
    expect(
      fuzzyEvaluateAnswer(
        "Je voudrais du cafe et un croissant s'il vous plait",
        "Je voudrais du cafe et un croissant, s'il vous plait",
        [],
        'writing'
      )
    ).toBeNull();
  });
});
