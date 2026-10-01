import { describe, expect, it } from 'vitest';
import { MODEL_CONSTRAINTS, MODELS } from '../src/models';

describe('MODEL_CONSTRAINTS', () => {
  it('flags Sonnet 5.5 as needing a fixed temperature', () => {
    expect(MODEL_CONSTRAINTS['anthropic/claude-sonnet-5.5']).toEqual({ fixedTemperature: true });
  });

  it('carries no entry for a model with no known sampling constraint', () => {
    expect(MODEL_CONSTRAINTS[MODELS.pdfConversion]).toBeUndefined();
  });
});
