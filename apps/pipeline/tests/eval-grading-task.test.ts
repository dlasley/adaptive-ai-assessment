/**
 * `gradingTask.outcomeFromStoredResult` reads the design-time label class off `eval_items.seeded_class`
 * first, falling back to `payload.label_class` for a row written before the column existed
 * (`seededLabelClass` in `lib/eval/set-builder.ts`). These tests pin that fallback and show it
 * produces the same `byDesignLabel` breakdown either way, since that's the one place the grading
 * summariser's design-label numbers are computed from.
 */

import { describe, expect, it } from 'vitest';
import { gradingTask } from '../src/lib/eval/tasks/grading';
import { makeEvalItemRow, makeEvalResultRow } from './helpers/eval-store';

describe('gradingTask.outcomeFromStoredResult label class resolution', () => {
  it('reads seeded_class when present', () => {
    const item = makeEvalItemRow({
      seeded_class: 'wrong',
      payload: { question: 'q', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy' },
    });
    const result = makeEvalResultRow({ output: { isCorrect: false, score: 10 } });
    expect(gradingTask.outcomeFromStoredResult(result, item).labelClass).toBe('wrong');
  });

  it('falls back to payload.label_class when seeded_class is null', () => {
    const item = makeEvalItemRow({
      seeded_class: null,
      payload: { question: 'q', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'typo' },
    });
    const result = makeEvalResultRow({ output: { isCorrect: true, score: 95 } });
    expect(gradingTask.outcomeFromStoredResult(result, item).labelClass).toBe('typo');
  });
});

describe('gradingTask.buildSummary byDesignLabel is unaffected by where the label class is read from', () => {
  it('produces the same breakdown for an item with seeded_class set (payload carries no label_class) as for one with only the payload key', () => {
    const itemViaColumn = makeEvalItemRow({
      id: 'item-column',
      seeded_class: 'correct',
      payload: { question: 'q1', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy' },
    });
    const itemViaPayload = makeEvalItemRow({
      id: 'item-payload',
      seeded_class: null,
      payload: { question: 'q2', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' },
    });

    const resultViaColumn = makeEvalResultRow({ id: 'result-column', item_id: 'item-column', output: { isCorrect: true, score: 100 } });
    const resultViaPayload = makeEvalResultRow({ id: 'result-payload', item_id: 'item-payload', output: { isCorrect: true, score: 100 } });

    const summaryViaColumn = gradingTask.buildSummary([gradingTask.outcomeFromStoredResult(resultViaColumn, itemViaColumn)]);
    const summaryViaPayload = gradingTask.buildSummary([gradingTask.outcomeFromStoredResult(resultViaPayload, itemViaPayload)]);

    expect(summaryViaColumn.byDesignLabel.correct).toEqual(summaryViaPayload.byDesignLabel.correct);
  });
});
