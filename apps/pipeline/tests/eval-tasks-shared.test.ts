import { describe, expect, it } from 'vitest';
import { resolveEffectiveSamplingSettings } from '../src/lib/eval/tasks/shared';

const SONNET_5_5 = 'anthropic/claude-sonnet-5.5';
const UNCONSTRAINED_MODEL = 'anthropic/claude-sonnet-5';

describe('resolveEffectiveSamplingSettings', () => {
  it('passes temperature and reasoning through unchanged for a model with no known constraint', () => {
    const result = resolveEffectiveSamplingSettings(UNCONSTRAINED_MODEL, 0.1, { enabled: false }, false);
    expect(result).toEqual({ temperature: 0.1, reasoning: { enabled: false }, adjustments: [] });
  });

  it('drops the temperature for a fixedTemperature model', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, 0.1, undefined, false);
    expect(result.temperature).toBeUndefined();
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]).toContain('dropped temperature');
  });

  it('leaves temperature alone for a fixedTemperature model when none was intended', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, undefined, undefined, false);
    expect(result.temperature).toBeUndefined();
    expect(result.adjustments).toEqual([]);
  });

  it('raises a default-disabled reasoning request to the lowest effort tier for a reasoningRequired model', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, undefined, { enabled: false }, false);
    expect(result.reasoning).toEqual({ effort: 'minimal' });
    expect(result.adjustments.some((a) => a.includes('reasoning'))).toBe(true);
  });

  it('does not touch an explicit --reasoning off on a reasoningRequired model', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, undefined, { enabled: false }, true);
    expect(result.reasoning).toEqual({ enabled: false });
    expect(result.adjustments).toEqual([]);
  });

  it('does not touch a reasoning request that is not disabling reasoning outright', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, undefined, { effort: 'low' }, false);
    expect(result.reasoning).toEqual({ effort: 'low' });
    expect(result.adjustments).toEqual([]);
  });

  it('does not touch reasoning for a task whose intended default is undefined (no disabling at all)', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, undefined, undefined, false);
    expect(result.reasoning).toBeUndefined();
    expect(result.adjustments).toEqual([]);
  });

  it('applies both adjustments at once when both are needed', () => {
    const result = resolveEffectiveSamplingSettings(SONNET_5_5, 0.3, { enabled: false }, false);
    expect(result.temperature).toBeUndefined();
    expect(result.reasoning).toEqual({ effort: 'minimal' });
    expect(result.adjustments).toHaveLength(2);
  });
});
