import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/commands/eval-seed-grading';
import { computeDeterministicAnswer } from '../src/lib/eval/grading-seed';
import type { EvalStore, EvalItemRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow } from './helpers/eval-store';

/**
 * Exercises the deterministic (typo/missing_accent) seeding path through an injected fake store, with
 * no model call — `computeDeterministicAnswer` covers those two label classes without asking a model,
 * so a question whose only pending items are `typo`/`missing_accent` never reaches the `callLlm` branch.
 */
describe('eval-seed-grading main() --write-db (deterministic path)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeFakeStore(items: EvalItemRow[]): { store: EvalStore; updateItemCalls: Array<{ id: string; patch: Partial<EvalItemRow> }> } {
    const set = makeEvalSetRow({ task: 'grading' });
    const updateItemCalls: Array<{ id: string; patch: Partial<EvalItemRow> }> = [];

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === set.id ? set : null; },
      async listItems(setId) { return setId === set.id ? items : []; },
      async updateItem(id, patch) { updateItemCalls.push({ id, patch }); },
    };

    return { store, updateItemCalls };
  }

  it('writes the deterministic typo and missing_accent answers, without calling a model', async () => {
    const items = [
      makeEvalItemRow({
        id: 'item-typo',
        item_key: 'item-typo',
        payload: { question_id: 'q1', question: 'Comment dit-on "hello"?', correct_answer: 'bonjour', type: 'fill-in-blank', difficulty: 'easy', label_class: 'typo' },
      }),
      makeEvalItemRow({
        id: 'item-accent',
        item_key: 'item-accent',
        payload: { question_id: 'q2', question: 'Comment dit-on "coffee"?', correct_answer: 'café', type: 'fill-in-blank', difficulty: 'easy', label_class: 'missing_accent' },
      }),
    ];
    const { store, updateItemCalls } = makeFakeStore(items);

    await main({ argv: ['--set', 'set-1', '--model', 'openai/gpt-4.1-nano', '--write-db'], store });

    const typoAnswer = computeDeterministicAnswer('typo', 'bonjour');
    const accentAnswer = computeDeterministicAnswer('missing_accent', 'café');
    expect(typoAnswer.kind).toBe('answer');
    expect(accentAnswer.kind).toBe('answer');

    expect(updateItemCalls).toHaveLength(2);
    const byId = new Map(updateItemCalls.map((c) => [c.id, c.patch]));
    expect((byId.get('item-typo')?.payload as Record<string, unknown>)?.submitted_answer).toBe(
      typoAnswer.kind === 'answer' ? typoAnswer.value : undefined,
    );
    expect((byId.get('item-accent')?.payload as Record<string, unknown>)?.submitted_answer).toBe(
      accentAnswer.kind === 'answer' ? accentAnswer.value : undefined,
    );
  });

  it('makes no store write in a dry run', async () => {
    const items = [
      makeEvalItemRow({
        id: 'item-typo',
        item_key: 'item-typo',
        payload: { question_id: 'q1', question: 'Comment dit-on "hello"?', correct_answer: 'bonjour', type: 'fill-in-blank', difficulty: 'easy', label_class: 'typo' },
      }),
    ];
    const { store, updateItemCalls } = makeFakeStore(items);

    await main({ argv: ['--set', 'set-1', '--model', 'openai/gpt-4.1-nano'], store });

    expect(updateItemCalls).toHaveLength(0);
  });
});
