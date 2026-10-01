import { describe, expect, it } from 'vitest';
import { resolveDecidedBy } from '../src/lib/eval/decided-by';

describe('resolveDecidedBy', () => {
  it('returns the flag when given, ignoring the environment', () => {
    expect(resolveDecidedBy('jsmith', { EVAL_DECIDED_BY: 'env-operator' })).toBe('jsmith');
  });

  it('falls back to EVAL_DECIDED_BY when the flag is undefined', () => {
    expect(resolveDecidedBy(undefined, { EVAL_DECIDED_BY: 'env-operator' })).toBe('env-operator');
  });

  it('returns undefined when neither is set', () => {
    expect(resolveDecidedBy(undefined, {})).toBeUndefined();
  });

  it('treats a blank flag as not given, falling back to the environment', () => {
    expect(resolveDecidedBy('   ', { EVAL_DECIDED_BY: 'env-operator' })).toBe('env-operator');
  });

  it('treats a blank EVAL_DECIDED_BY as unset', () => {
    expect(resolveDecidedBy(undefined, { EVAL_DECIDED_BY: '   ' })).toBeUndefined();
  });

  it('trims the resolved value', () => {
    expect(resolveDecidedBy('  jsmith  ', {})).toBe('jsmith');
  });
});
