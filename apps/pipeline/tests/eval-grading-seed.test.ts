import { describe, expect, it } from 'vitest';
import {
  stripAccents,
  computeTypoAnswer,
  computeDeterministicAnswer,
  renderSeedGradingPrompt,
  parseSeedGradingResponse,
  SeedGradingParseError,
  MODEL_SEEDED_LABEL_CLASSES,
  DETERMINISTIC_LABEL_CLASSES,
} from '../src/lib/eval/grading-seed';
import { GRADING_LABEL_CLASSES } from '../src/lib/eval/set-builder';

describe('DETERMINISTIC_LABEL_CLASSES / MODEL_SEEDED_LABEL_CLASSES', () => {
  it('partition all label classes with no overlap', () => {
    const combined = [...DETERMINISTIC_LABEL_CLASSES, ...MODEL_SEEDED_LABEL_CLASSES].sort();
    expect(combined).toEqual([...GRADING_LABEL_CLASSES].sort());
    const overlap = DETERMINISTIC_LABEL_CLASSES.filter((c) => (MODEL_SEEDED_LABEL_CLASSES as readonly string[]).includes(c));
    expect(overlap).toEqual([]);
  });
});

describe('stripAccents', () => {
  it('removes diacritics while preserving case', () => {
    expect(stripAccents('café')).toBe('cafe');
    expect(stripAccents('Été')).toBe('Ete');
    expect(stripAccents('où')).toBe('ou');
    expect(stripAccents('ça')).toBe('ca');
    expect(stripAccents('élève')).toBe('eleve');
  });

  it('expands ligatures that NFD normalization does not decompose', () => {
    expect(stripAccents('œuf')).toBe('oeuf');
    expect(stripAccents('sœur')).toBe('soeur');
    expect(stripAccents('cœur')).toBe('coeur');
    expect(stripAccents('Œuvre')).toBe('OEuvre');
    expect(stripAccents('nævus')).toBe('naevus');
  });

  it('leaves plain ASCII unchanged', () => {
    expect(stripAccents('bonjour')).toBe('bonjour');
  });
});

describe('computeTypoAnswer', () => {
  it('swaps two adjacent characters near the middle for a normal word', () => {
    const result = computeTypoAnswer('bonjour');
    expect(result).not.toBe('bonjour');
    expect(result).toBeDefined();
    expect(result!.length).toBe('bonjour'.length);
    expect([...result!].sort()).toEqual([...'bonjour'].sort());
  });

  it('never returns the original: falls back past a doubled letter at the preferred swap position', () => {
    // 'assez': preferred index (floor(5/2)-1 = 1) is the 's'/'s' pair — swapping it is a no-op,
    // so the function must search for a different adjacent pair instead of returning 'assez'.
    const result = computeTypoAnswer('assez');
    expect(result).toBeDefined();
    expect(result).not.toBe('assez');
    expect(result!.length).toBe(5);
    expect([...result!].sort()).toEqual([...'assez'].sort());
  });

  it('returns undefined when every adjacent pair is identical', () => {
    expect(computeTypoAnswer('aa')).toBeUndefined();
  });

  it('only swaps two letters inside one word, never across a space or punctuation', () => {
    const result = computeTypoAnswer('êtes, avez');
    expect(result).toBeDefined();
    expect(result).not.toBe('êtes, avez');
    // The comma and the space stay where they were; only letters moved.
    expect(result!.replace(/\p{L}/gu, 'x')).toBe('êtes, avez'.replace(/\p{L}/gu, 'x'));
  });

  it('returns undefined when the answer has no adjacent pair of different letters', () => {
    expect(computeTypoAnswer('14')).toBeUndefined();
    expect(computeTypoAnswer('a b')).toBeUndefined();
  });

  it('returns undefined for answers shorter than two characters', () => {
    expect(computeTypoAnswer('a')).toBeUndefined();
    expect(computeTypoAnswer('')).toBeUndefined();
  });

  it('is deterministic', () => {
    expect(computeTypoAnswer('bonjour')).toBe(computeTypoAnswer('bonjour'));
  });
});

describe('computeDeterministicAnswer', () => {
  it('returns the typo transform for typo', () => {
    expect(computeDeterministicAnswer('typo', 'bonjour')).toEqual({ kind: 'answer', value: computeTypoAnswer('bonjour') });
  });

  it('rejects typo when no adjacent swap can change the answer', () => {
    expect(computeDeterministicAnswer('typo', 'aa')).toEqual({ kind: 'rejected', reason: expect.any(String) });
  });

  it('returns accent-stripped text for missing_accent', () => {
    expect(computeDeterministicAnswer('missing_accent', 'café')).toEqual({ kind: 'answer', value: 'cafe' });
  });

  it('rejects missing_accent when the correct answer has no accent to strip', () => {
    expect(computeDeterministicAnswer('missing_accent', 'bonjour')).toEqual({ kind: 'rejected', reason: expect.any(String) });
  });

  it('reports not-deterministic for a model-seeded label class', () => {
    expect(computeDeterministicAnswer('correct', 'bonjour')).toEqual({ kind: 'not-deterministic' });
    expect(computeDeterministicAnswer('wrong', 'bonjour')).toEqual({ kind: 'not-deterministic' });
  });
});

describe('renderSeedGradingPrompt', () => {
  it('substitutes every placeholder', () => {
    const rendered = renderSeedGradingPrompt(
      'Type: {{QUESTION_TYPE}} Diff: {{DIFFICULTY}} Q: {{QUESTION}} A: {{CORRECT_ANSWER}} Cats: {{LABEL_CLASSES}}',
      { questionType: 'fill-in-blank', difficulty: 'beginner', question: 'Say hello', correctAnswer: 'bonjour', labelClasses: ['correct', 'wrong'] },
    );
    expect(rendered).toBe('Type: fill-in-blank Diff: beginner Q: Say hello A: bonjour Cats: correct, wrong');
  });
});

describe('parseSeedGradingResponse', () => {
  it('parses a well-formed response with every requested key', () => {
    const result = parseSeedGradingResponse(
      JSON.stringify({ correct: 'bonjour', wrong: 'au revoir' }),
      ['correct', 'wrong'],
    );
    expect(result).toEqual({ correct: 'bonjour', wrong: 'au revoir' });
  });

  it('strips markdown code fences', () => {
    const result = parseSeedGradingResponse('```json\n' + JSON.stringify({ correct: 'bonjour' }) + '\n```', ['correct']);
    expect(result).toEqual({ correct: 'bonjour' });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSeedGradingResponse('not json', ['correct'])).toThrow(SeedGradingParseError);
  });

  it('throws when a requested label class is missing', () => {
    expect(() => parseSeedGradingResponse(JSON.stringify({ correct: 'bonjour' }), ['correct', 'wrong'])).toThrow(SeedGradingParseError);
  });

  it('throws when a value is empty or not a string', () => {
    expect(() => parseSeedGradingResponse(JSON.stringify({ correct: '' }), ['correct'])).toThrow(SeedGradingParseError);
    expect(() => parseSeedGradingResponse(JSON.stringify({ correct: 5 }), ['correct'])).toThrow(SeedGradingParseError);
  });
});
