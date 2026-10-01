import { describe, expect, it } from 'vitest';
import { resolveEffectiveSamplingSettings } from '../src/lib/eval/tasks/shared';
import type { ModelSamplingConstraints } from '../src/lib/eval/tasks/types';

const UNCONSTRAINED: ModelSamplingConstraints = { fixedTemperature: false, reasoningMandatory: false, fallbackReasoningEffort: 'low' };
const FIXED_TEMPERATURE_MANDATORY_REASONING: ModelSamplingConstraints = { fixedTemperature: true, reasoningMandatory: true, fallbackReasoningEffort: 'low' };

describe('resolveEffectiveSamplingSettings', () => {
  it('passes temperature and reasoning through unchanged for a model with no constraints', () => {
    const result = resolveEffectiveSamplingSettings(UNCONSTRAINED, 0.1, { enabled: false }, false);
    expect(result).toEqual({ temperature: 0.1, reasoning: { enabled: false }, adjustments: [] });
  });

  it('drops the temperature for a fixedTemperature model', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, 0.1, undefined, false);
    expect(result.temperature).toBeUndefined();
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]).toContain('dropped temperature');
  });

  it('leaves temperature alone for a fixedTemperature model when none was intended', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, undefined, undefined, false);
    expect(result.temperature).toBeUndefined();
    expect(result.adjustments).toEqual([]);
  });

  it('raises a default-disabled reasoning request to the constraint\'s fallback effort for a reasoningMandatory model', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, undefined, { enabled: false }, false);
    expect(result.reasoning).toEqual({ effort: 'low' });
    expect(result.adjustments.some((a) => a.includes('reasoning'))).toBe(true);
  });

  it('does not touch an explicit --reasoning off on a reasoningMandatory model', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, undefined, { enabled: false }, true);
    expect(result.reasoning).toEqual({ enabled: false });
    expect(result.adjustments).toEqual([]);
  });

  it('does not touch a reasoning request that is not disabling reasoning outright', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, undefined, { effort: 'low' }, false);
    expect(result.reasoning).toEqual({ effort: 'low' });
    expect(result.adjustments).toEqual([]);
  });

  it('does not touch reasoning for a task whose intended default is undefined (no disabling at all)', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, undefined, undefined, false);
    expect(result.reasoning).toBeUndefined();
    expect(result.adjustments).toEqual([]);
  });

  it('applies both adjustments at once when both are needed', () => {
    const result = resolveEffectiveSamplingSettings(FIXED_TEMPERATURE_MANDATORY_REASONING, 0.3, { enabled: false }, false);
    expect(result.temperature).toBeUndefined();
    expect(result.reasoning).toEqual({ effort: 'low' });
    expect(result.adjustments).toHaveLength(2);
  });

  it('sends the constraint\'s own fallback effort, not a hardcoded one', () => {
    const result = resolveEffectiveSamplingSettings({ fixedTemperature: false, reasoningMandatory: true, fallbackReasoningEffort: 'medium' }, undefined, { enabled: false }, false);
    expect(result.reasoning).toEqual({ effort: 'medium' });
  });
});
