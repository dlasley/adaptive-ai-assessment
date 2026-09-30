import { describe, expect, it } from 'vitest';
import {
  EVALUATION_TIER_LABELS,
  formatQuestionTypeLabel,
  formatTypedAnswerQuestionTypeLabel,
  getEvaluationTierLabel,
  getMatchedAgainstLabel,
} from '@/lib/superuser-metadata-labels';

describe('getEvaluationTierLabel', () => {
  it('labels every known tier with a stable hyphenated format', () => {
    expect(getEvaluationTierLabel('empty_check')).toBe('1 - Empty Check');
    expect(getEvaluationTierLabel('exact_match')).toBe('2 - Exact Match');
    expect(getEvaluationTierLabel('fuzzy_logic')).toBe('3 - Fuzzy Logic');
    expect(getEvaluationTierLabel('claude_api')).toBe('4 - Semantic API');
  });

  it('falls back to the raw value for an unknown tier', () => {
    expect(getEvaluationTierLabel('unknown_tier')).toBe('unknown_tier');
  });

  it('every entry in the tier map uses the same "N - Label" format', () => {
    for (const label of Object.values(EVALUATION_TIER_LABELS)) {
      expect(label).toMatch(/^\d - .+$/);
    }
  });
});

describe('getMatchedAgainstLabel', () => {
  it('labels a primary-answer match', () => {
    expect(getMatchedAgainstLabel('primary_answer')).toBe('Primary Answer');
  });

  it('labels a variation match with a 1-indexed variation number', () => {
    expect(getMatchedAgainstLabel('acceptable_variation', 0)).toBe('Variation #1');
    expect(getMatchedAgainstLabel('acceptable_variation', 2)).toBe('Variation #3');
  });

  it('defaults to variation #1 when no index is given', () => {
    expect(getMatchedAgainstLabel('acceptable_variation')).toBe('Variation #1');
  });

  it('labels no match', () => {
    expect(getMatchedAgainstLabel('none')).toBe('None');
  });

  it('falls back to the raw value for an unknown match type', () => {
    expect(getMatchedAgainstLabel('something_else')).toBe('something_else');
  });
});

describe('formatQuestionTypeLabel', () => {
  it('title-cases each hyphen-separated word', () => {
    expect(formatQuestionTypeLabel('multiple-choice')).toBe('Multiple Choice');
    expect(formatQuestionTypeLabel('true-false')).toBe('True False');
  });

  it('title-cases a single-word type', () => {
    expect(formatQuestionTypeLabel('writing')).toBe('Writing');
  });
});

describe('formatTypedAnswerQuestionTypeLabel', () => {
  it('labels fill-in-blank with a lowercase "in"', () => {
    expect(formatTypedAnswerQuestionTypeLabel('fill-in-blank')).toBe('Fill in Blank');
  });

  it('labels writing', () => {
    expect(formatTypedAnswerQuestionTypeLabel('writing')).toBe('Writing');
  });
});
