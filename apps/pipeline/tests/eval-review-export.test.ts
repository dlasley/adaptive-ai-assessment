import { describe, expect, it } from 'vitest';
import {
  auditCorrectAnswerCell,
  buildAuditReferenceRows,
  buildGradingReferenceRows,
  AUDIT_COLUMNS,
  GRADING_COLUMNS,
  type ReferenceRow,
} from '../src/lib/eval/review-export';
import { AUDIT_GATE_CRITERIA } from '../src/lib/eval/runner';
import type { EvalItemRow } from '../src/lib/eval/db';

function makeItem(id: string, payload: Record<string, unknown>): EvalItemRow {
  return {
    id,
    set_id: 'set-1',
    item_key: id,
    payload,
    reference: null,
    reference_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    created_at: '',
    updated_at: '',
  };
}

describe('auditCorrectAnswerCell', () => {
  it('prefixes a multiple-choice answer with its 1-based option position', () => {
    const item = makeItem('i-1', {
      type: 'multiple-choice',
      correct_answer: 'le premier février',
      options: ['le lundi', 'le mardi', 'le premier février'],
    });
    const warnings: string[] = [];
    expect(auditCorrectAnswerCell(item, warnings)).toBe('3. le premier février');
    expect(warnings).toEqual([]);
  });

  it('leaves the answer unprefixed and warns when no option matches exactly', () => {
    const item = makeItem('i-2', {
      type: 'multiple-choice',
      correct_answer: 'le premier février',
      options: ['le lundi', 'le mardi'],
    });
    const warnings: string[] = [];
    expect(auditCorrectAnswerCell(item, warnings)).toBe('le premier février');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('i-2');
  });

  it('leaves non-multiple-choice answers bare', () => {
    const item = makeItem('i-3', { type: 'true-false', correct_answer: 'Vrai', options: null });
    expect(auditCorrectAnswerCell(item, [])).toBe('Vrai');
  });
});

describe('buildAuditReferenceRows', () => {
  const items = [
    makeItem('i-1', { type: 'true-false', difficulty: 'beginner', topic: 'Greetings', question: 'Q1', correct_answer: 'Vrai', options: null, acceptable_variations: null }),
    makeItem('i-2', { type: 'fill-in-blank', difficulty: 'advanced', topic: 'Verbs', question: 'Q2', correct_answer: 'mange', options: null, acceptable_variations: ['manges'] }),
    makeItem('i-3', { type: 'writing', difficulty: 'intermediate', topic: 'Food', question: 'Q3', correct_answer: 'Je mange.', options: null, acceptable_variations: null }),
  ];

  it('numbers ref 1..N after shuffling, and leaves every criterion/borderline/reason cell blank', () => {
    const { rows, warnings } = buildAuditReferenceRows(items, 42);
    expect(warnings).toEqual([]);
    expect(rows.map((r) => r.ref)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.item_id).sort()).toEqual(['i-1', 'i-2', 'i-3']);
    for (const row of rows) {
      for (const criterion of AUDIT_GATE_CRITERIA) expect(row[criterion]).toBe('');
      expect(row.borderline).toBe('');
      expect(row.reason).toBe('');
    }
  });

  it('is deterministic under a fixed seed and varies with a different one', () => {
    const first = buildAuditReferenceRows(items, 7).rows.map((r) => r.item_id);
    const second = buildAuditReferenceRows(items, 7).rows.map((r) => r.item_id);
    expect(second).toEqual(first);

    const third = buildAuditReferenceRows(items, 999).rows.map((r) => r.item_id);
    expect(third).not.toEqual(first);
  });

  it('carries difficulty and topic through as plain strings', () => {
    const { rows } = buildAuditReferenceRows(items, 1);
    const row = rows.find((r) => r.item_id === 'i-2')!;
    expect(row.difficulty).toBe('advanced');
    expect(row.topic).toBe('Verbs');
    expect(row.acceptable_variations).toBe('manges');
  });
});

describe('buildGradingReferenceRows', () => {
  const items = [
    makeItem('q1-correct', { question_id: 'q1', type: 'fill-in-blank', question: 'Q1', correct_answer: 'a', submitted_answer: 'a' }),
    makeItem('q1-wrong', { question_id: 'q1', type: 'fill-in-blank', question: 'Q1', correct_answer: 'a', submitted_answer: 'b' }),
    makeItem('q2-correct', { question_id: 'q2', type: 'writing', question: 'Q2', correct_answer: 'c', submitted_answer: 'c' }),
    makeItem('q2-wrong', { question_id: 'q2', type: 'writing', question: 'Q2', correct_answer: 'c', submitted_answer: 'd' }),
  ];

  it('numbers ref 1..N and groups each question under one question_group', () => {
    const rows = buildGradingReferenceRows(items, 3);
    expect(rows.map((r) => r.ref)).toEqual([1, 2, 3, 4]);

    const byQuestionGroup = new Map<string, string[]>();
    for (const row of rows) {
      const list = byQuestionGroup.get(row.question_group as string) ?? [];
      list.push(row.item_id as string);
      byQuestionGroup.set(row.question_group as string, list);
    }
    expect(byQuestionGroup.size).toBe(2);
    for (const [, ids] of byQuestionGroup) {
      // Every item in a block belongs to the same source question.
      const questionIds = new Set(ids.map((id) => items.find((i) => i.id === id)!.payload.question_id));
      expect(questionIds.size).toBe(1);
    }
    // Rows for a question stay contiguous — a block isn't interleaved with another question's rows.
    const questionGroupSequence = rows.map((r) => r.question_group);
    const firstChangeIndex = questionGroupSequence.findIndex((q) => q !== questionGroupSequence[0]);
    expect(questionGroupSequence.slice(firstChangeIndex).every((q) => q === questionGroupSequence[firstChangeIndex])).toBe(true);
  });

  it('is deterministic under a fixed seed (group order and within-group order)', () => {
    const first = buildGradingReferenceRows(items, 11).map((r) => ({ item_id: r.item_id, question_group: r.question_group }));
    const second = buildGradingReferenceRows(items, 11).map((r) => ({ item_id: r.item_id, question_group: r.question_group }));
    expect(second).toEqual(first);
  });

  it('never includes label_class', () => {
    const rows = buildGradingReferenceRows(items, 1);
    for (const row of rows) expect(row).not.toHaveProperty('label_class');
  });

  it('marks exactly one row per group as _firstOfGroup, and leaves key_incorrect/key_note blank on every row', () => {
    const rows = buildGradingReferenceRows(items, 1);
    for (const row of rows) {
      expect(row.key_incorrect).toBe('');
      expect(row.key_note).toBe('');
    }

    const byQuestionGroup = new Map<string, ReferenceRow[]>();
    for (const row of rows) {
      const list = byQuestionGroup.get(row.question_group as string) ?? [];
      list.push(row);
      byQuestionGroup.set(row.question_group as string, list);
    }
    for (const [, groupRows] of byQuestionGroup) {
      expect(groupRows.filter((r) => r._firstOfGroup === 1)).toHaveLength(1);
      expect(groupRows.filter((r) => r._firstOfGroup === 0)).toHaveLength(groupRows.length - 1);
    }
  });
});

describe('column layouts', () => {
  it('audit columns match the decided order, with item_id and difficulty hidden', () => {
    expect(AUDIT_COLUMNS.map((c) => c.name)).toEqual([
      'ref', 'item_id', 'type', 'difficulty', 'topic', 'question', 'options',
      'answer_key', 'acceptable_variations',
      ...AUDIT_GATE_CRITERIA,
      'borderline', 'reason',
    ]);
    expect(AUDIT_COLUMNS.find((c) => c.name === 'item_id')?.hidden).toBe(true);
    expect(AUDIT_COLUMNS.find((c) => c.name === 'difficulty')?.hidden).toBe(true);
    for (const criterion of AUDIT_GATE_CRITERIA) {
      const col = AUDIT_COLUMNS.find((c) => c.name === criterion)!;
      expect(col.editable).toBe(true);
      expect(col.validation).toEqual(['Pass', 'Fail']);
    }
    const borderline = AUDIT_COLUMNS.find((c) => c.name === 'borderline')!;
    expect(borderline.validation).toEqual(['TRUE', 'FALSE']);
    expect(borderline.validationAllowBlank).toBe(true);
    const reason = AUDIT_COLUMNS.find((c) => c.name === 'reason')!;
    expect(reason.editable).toBe(true);
    expect(reason.validation).toBeUndefined();
  });

  it('grading columns match the decided order, with item_id hidden', () => {
    expect(GRADING_COLUMNS.map((c) => c.name)).toEqual([
      'ref', 'question_group', 'item_id', 'type', 'question', 'answer_key',
      'key_incorrect', 'key_note', 'acceptable_variations', 'student_answer', 'is_correct', 'borderline', 'reason',
    ]);
    expect(GRADING_COLUMNS.find((c) => c.name === 'item_id')?.hidden).toBe(true);
    const isCorrect = GRADING_COLUMNS.find((c) => c.name === 'is_correct')!;
    expect(isCorrect.editable).toBe(true);
    expect(isCorrect.validation).toEqual(['Correct', 'Incorrect']);
  });

  it('key_incorrect/key_note are conditionally editable (first row of the group only), not unconditionally editable', () => {
    const keyIncorrect = GRADING_COLUMNS.find((c) => c.name === 'key_incorrect')!;
    const keyNote = GRADING_COLUMNS.find((c) => c.name === 'key_note')!;
    expect(keyIncorrect.conditionalEditable).toBe(true);
    expect(keyIncorrect.editable).toBeFalsy();
    expect(keyIncorrect.validation).toEqual(['TRUE', 'FALSE']);
    expect(keyIncorrect.validationAllowBlank).toBe(true);
    expect(keyNote.conditionalEditable).toBe(true);
    expect(keyNote.editable).toBeFalsy();
  });
});
