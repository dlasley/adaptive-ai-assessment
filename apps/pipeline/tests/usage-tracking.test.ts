import { describe, expect, it } from 'vitest';
import {
  addStageUsageTotals,
  addUsageTotals,
  emptyStageUsage,
  emptyUsageTotals,
  formatUsageSummary,
  recordCall,
} from '../src/lib/usage-tracking';

describe('recordCall', () => {
  it('always increments calls, even when usage is undefined', () => {
    const totals = emptyUsageTotals();
    recordCall(totals, undefined);
    expect(totals.calls).toBe(1);
    expect(totals.cost_usd).toBe(0);
  });

  it('adds every field from a full usage object', () => {
    const totals = emptyUsageTotals();
    recordCall(totals, {
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 10,
      costUsd: 0.01,
      isByok: true,
    });
    expect(totals).toEqual({
      calls: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
      reasoning_tokens: 10,
      cost_usd: 0.01,
      byok_calls: 1,
    });
  });

  it('does not count byok_calls when isByok is false or absent', () => {
    const totals = emptyUsageTotals();
    recordCall(totals, { promptTokens: 1 });
    expect(totals.byok_calls).toBe(0);
  });
});

describe('addUsageTotals / addStageUsageTotals', () => {
  it('sums two totals field by field', () => {
    const a = { calls: 1, prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 1, cost_usd: 0.1, byok_calls: 1 };
    const b = { calls: 2, prompt_tokens: 20, completion_tokens: 10, reasoning_tokens: 2, cost_usd: 0.2, byok_calls: 0 };
    addUsageTotals(a, b);
    expect(a).toEqual({ calls: 3, prompt_tokens: 30, completion_tokens: 15, reasoning_tokens: 3, cost_usd: 0.30000000000000004, byok_calls: 1 });
  });

  it('also sums json_failures for StageUsage', () => {
    const a = emptyStageUsage();
    a.json_failures = 2;
    const b = emptyStageUsage();
    b.json_failures = 3;
    addStageUsageTotals(a, b);
    expect(a.json_failures).toBe(5);
  });
});

describe('formatUsageSummary', () => {
  it('formats calls, tokens, and cost to 4 decimal places', () => {
    const totals = { calls: 3, prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 0, cost_usd: 0.012345, byok_calls: 0 };
    expect(formatUsageSummary(totals)).toBe('Usage: 3 calls, 100 prompt / 50 completion tokens, $0.0123');
  });

  it('uses singular "call" for exactly one call', () => {
    const totals = emptyUsageTotals();
    totals.calls = 1;
    expect(formatUsageSummary(totals)).toContain('1 call,');
  });
});
