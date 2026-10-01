/**
 * The variant-identity vocabulary in `eval-run.ts`: the absent-means-default rule for `mode` and
 * `grouping`, what makes two runs repeats of each other, and `declaredVariantMatchesRun`, the
 * TypeScript twin of the `eval_experiment_variants` match rule.
 */

import { describe, expect, it } from 'vitest';
import {
  declaredVariantMatchesRun,
  normalizeRepeatIdentitySettings,
  resolveExistingRepeatCount,
  type DeclaredVariant,
} from '../src/commands/eval-run';
import type { EvalRunRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalRunRow } from './helpers/eval-store';

describe('normalizeRepeatIdentitySettings: mode and grouping', () => {
  it('fills mode with sync and grouping with by_order when the settings carry neither', () => {
    const normalized = normalizeRepeatIdentitySettings({}, 'audit');
    expect(normalized.mode).toBe('sync');
    expect(normalized.grouping).toBe('by_order');
  });

  it('keeps an explicit mode or grouping', () => {
    const normalized = normalizeRepeatIdentitySettings({ mode: 'batch', grouping: 'by_topic' }, 'audit');
    expect(normalized.mode).toBe('batch');
    expect(normalized.grouping).toBe('by_topic');
  });
});

describe('resolveExistingRepeatCount: mode and grouping are part of a run identity', () => {
  const existing = (settings: Record<string, unknown>): EvalRunRow => makeEvalRunRow({
    id: `run-${JSON.stringify(settings)}`,
    set_id: 'set-1',
    task: 'audit',
    model: 'm',
    status: 'completed',
    prompt_hash: 'h',
    experiment_id: 'exp-1',
    settings,
  });

  async function count(existingRuns: EvalRunRow[], newSettings: Record<string, unknown>): Promise<number> {
    const store = { ...baseFakeEvalStore(), async listRunsByExperimentAndModel() { return existingRuns; } };
    return resolveExistingRepeatCount(store, 'exp-1', 'set-1', 'm', 'h', newSettings, 'audit');
  }

  it('a run with mode batch is not a repeat of one with no mode', async () => {
    expect(await count([existing({})], { mode: 'batch' })).toBe(0);
    expect(await count([existing({ mode: 'batch' })], {})).toBe(0);
  });

  it('an absent mode equals an explicit sync', async () => {
    expect(await count([existing({})], { mode: 'sync' })).toBe(1);
    expect(await count([existing({ mode: 'sync' })], {})).toBe(1);
  });

  it('a run with grouping by_topic is not a repeat of one with no grouping', async () => {
    expect(await count([existing({})], { grouping: 'by_topic' })).toBe(0);
  });

  it('an absent grouping equals an explicit by_order', async () => {
    expect(await count([existing({})], { grouping: 'by_order' })).toBe(1);
    expect(await count([existing({ grouping: 'by_order' })], {})).toBe(1);
  });
});

describe('declaredVariantMatchesRun', () => {
  const context = { declaringExperimentId: 'exp-1', experimentIdBySlug: new Map([['other', 'exp-2'], ['exp-1-slug', 'exp-1']]) };
  const run = (overrides: Partial<EvalRunRow> = {}): EvalRunRow => makeEvalRunRow({
    id: 'run-1',
    task: 'transcription',
    model: 'anthropic/claude-sonnet-5',
    status: 'completed',
    experiment_id: 'exp-1',
    settings: { provider: { order: ['Anthropic'], allowFallbacks: false }, reasoning: null, groupSize: 1, shuffleSeed: null },
    ...overrides,
  });
  const declared = (overrides: Partial<DeclaredVariant> = {}): DeclaredVariant => ({
    label: 'v', model_slug: 'anthropic/claude-sonnet-5', role: 'baseline', ...overrides,
  });

  it('matches on model with no settings declared, and never on another model', () => {
    expect(declaredVariantMatchesRun(declared(), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ model_slug: 'other/model' }), run(), context)).toBe(false);
  });

  it('a null or wildcard model_slug matches nothing', () => {
    expect(declaredVariantMatchesRun(declared({ model_slug: null }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ model_slug: '*' }), run(), context)).toBe(false);
  });

  it('failed and aborted runs never match', () => {
    expect(declaredVariantMatchesRun(declared(), run({ status: 'failed' }), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared(), run({ status: 'aborted' }), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared(), run({ status: 'running' }), context)).toBe(true);
  });

  it('only runs of the declaring experiment match unless baseline_from names another', () => {
    expect(declaredVariantMatchesRun(declared(), run({ experiment_id: 'exp-2' }), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ baseline_from: 'other' }), run({ experiment_id: 'exp-2' }), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ baseline_from: 'other' }), run({ experiment_id: 'exp-1' }), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ baseline_from: 'no-such' }), run(), context)).toBe(false);
  });

  it('compares each declared key against the normalised run value and leaves undeclared keys unconstrained', () => {
    expect(declaredVariantMatchesRun(declared({ settings: { groupSize: 1 } }), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { groupSize: 5 } }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { renderDpi: 120 } }), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { renderDpi: 200 } }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { temperature: 0.1 } }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { reasoning: null } }), run(), context)).toBe(true);
  });

  it('lowercases a provider pin on both sides', () => {
    expect(declaredVariantMatchesRun(declared({ settings: { provider: { order: ['anthropic'], allowFallbacks: false } } }), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { provider: { order: ['ANTHROPIC'], allowFallbacks: false } } }), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { provider: { order: ['mistral'], allowFallbacks: false } } }), run(), context)).toBe(false);
  });

  it('compares exclusionPass by classifier model slug only', () => {
    const gated = run({ settings: { exclusionPass: { model: 'google/gemini', provider: 'x', promptHash: 'abc' } } });
    expect(declaredVariantMatchesRun(declared({ settings: { exclusionPass: 'google/gemini' } }), gated, context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { exclusionPass: 'other/classifier' } }), gated, context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { exclusionPass: null } }), gated, context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { exclusionPass: null } }), run(), context)).toBe(true);
  });

  it('a declared mode of batch matches no run that has no mode, a declared sync matches it', () => {
    expect(declaredVariantMatchesRun(declared({ settings: { mode: 'batch' } }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { mode: 'sync' } }), run(), context)).toBe(true);
    expect(declaredVariantMatchesRun(declared({ settings: { grouping: 'by_topic' } }), run(), context)).toBe(false);
    expect(declaredVariantMatchesRun(declared({ settings: { grouping: 'by_order' } }), run(), context)).toBe(true);
  });

  it('ignores a declared key outside the identity vocabulary', () => {
    expect(declaredVariantMatchesRun(declared({ settings: { repeats: 3 } }), run(), context)).toBe(true);
  });
});
