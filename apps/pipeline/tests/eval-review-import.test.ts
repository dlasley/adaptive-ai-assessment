import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateAuditRows, validateGradingRows, isDescriptionRow, type CsvRow } from '../src/lib/eval/review-import';
import { writeReferenceWorkbook, readXlsxRows } from '../src/lib/eval/workbook';
import { writeCsv, parseCsv, csvRowsToObjects } from '../src/lib/eval/csv';
import { AUDIT_COLUMNS, buildAuditReferenceRows } from '../src/lib/eval/review-export';
import { main } from '../src/commands/eval-review-import';
import type { EvalItemRow, EvalReviewRoundRow, EvalStore, NewEvalReviewRoundRow } from '../src/lib/eval/db';
import { baseFakeEvalStore, makeEvalSetRow, makeEvalItemRow } from './helpers/eval-store';

const AUDIT_PASS_ROW: CsvRow = {
  item_id: 'i-1',
  answer_correct: 'pass',
  grammar_correct: 'pass',
  no_hallucination: 'pass',
  question_coherent: 'pass',
  natural_language: 'pass',
  register_appropriate: 'pass',
  borderline: '',
  reason: '',
};

const KNOWN_IDS = new Set(['i-1', 'i-2']);

describe('validateAuditRows', () => {
  it('accepts a fully passing row with no reason required', () => {
    const { errors, rows } = validateAuditRows([AUDIT_PASS_ROW], KNOWN_IDS);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{
      itemId: 'i-1',
      reference: {
        answer_correct: true, grammar_correct: true, no_hallucination: true,
        question_coherent: true, natural_language: true, register_appropriate: true,
        borderline: false, reason: null,
      },
    }]);
  });

  it('accepts TRUE/FALSE checkbox exports case-insensitively', () => {
    const row = { ...AUDIT_PASS_ROW, answer_correct: 'TRUE', grammar_correct: 'FALSE', reason: 'bad grammar' };
    const { errors, rows } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([]);
    expect(rows[0].reference.answer_correct).toBe(true);
    expect(rows[0].reference.grammar_correct).toBe(false);
  });

  it('rejects an item_id not in the set', () => {
    const row = { ...AUDIT_PASS_ROW, item_id: 'not-in-set' };
    const { errors, rows } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'not-in-set', message: 'item_id does not belong to this set' }]);
    expect(rows).toEqual([]);
  });

  it('rejects a blank item_id', () => {
    const row = { ...AUDIT_PASS_ROW, item_id: '' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: '(blank)', message: 'item_id is required' }]);
  });

  it('rejects a duplicate item_id', () => {
    const { errors, rows } = validateAuditRows([AUDIT_PASS_ROW, AUDIT_PASS_ROW], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: 'duplicate item_id' }]);
    expect(rows).toHaveLength(1);
  });

  it('rejects a malformed criterion cell', () => {
    const row = { ...AUDIT_PASS_ROW, grammar_correct: 'maybe' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "grammar_correct must be pass/fail (got 'maybe')" }]);
  });

  it('rejects a malformed borderline cell', () => {
    const row = { ...AUDIT_PASS_ROW, borderline: 'sort of' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "borderline must be empty/TRUE/FALSE/yes/no (got 'sort of')" }]);
  });

  it('requires a reason when any criterion fails', () => {
    const row = { ...AUDIT_PASS_ROW, grammar_correct: 'fail', reason: '' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: 'reason is required when any criterion fails or borderline is set' }]);
  });

  it('requires a reason when borderline is set, even with every criterion passing', () => {
    const row = { ...AUDIT_PASS_ROW, borderline: 'yes', reason: '' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: 'reason is required when any criterion fails or borderline is set' }]);
  });

  it('reports every violation across multiple rows before returning', () => {
    const rowA = { ...AUDIT_PASS_ROW, item_id: 'i-1', grammar_correct: 'fail', reason: '' };
    const rowB = { ...AUDIT_PASS_ROW, item_id: 'i-2', answer_correct: 'nope' };
    const { errors } = validateAuditRows([rowA, rowB], KNOWN_IDS);
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.itemId)).toEqual(['i-1', 'i-2']);
  });
});

describe('validateAuditRows — natural_french header alias', () => {
  it('reads a sheet exported before the natural_french -> natural_language rename into the natural_language reference field', () => {
    const { natural_language: _omit, ...withoutNaturalLanguage } = AUDIT_PASS_ROW as CsvRow & Record<string, string>;
    const legacyRow: CsvRow = { ...withoutNaturalLanguage, natural_french: 'pass' };

    const { errors, rows } = validateAuditRows([legacyRow], KNOWN_IDS);

    expect(errors).toEqual([]);
    expect(rows[0].reference.natural_language).toBe(true);
  });

  it('refuses a sheet carrying both the old and new headers', () => {
    const bothHeadersRow: CsvRow = { ...AUDIT_PASS_ROW, natural_french: 'pass' };

    const { errors, rows } = validateAuditRows([bothHeadersRow], KNOWN_IDS);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('natural_french');
    expect(errors[0].message).toContain('natural_language');
    expect(rows).toEqual([]);
  });
});

const GRADING_ROW: CsvRow = { item_id: 'i-1', question_group: 'Q1', key_incorrect: '', key_note: '', is_correct: 'correct', borderline: '', reason: '' };

describe('validateGradingRows', () => {
  it('accepts a correct row with no reason required', () => {
    const { errors, rows } = validateGradingRows([GRADING_ROW], KNOWN_IDS);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ itemId: 'i-1', reference: { isCorrect: true, borderline: false, reason: null, keyCorrect: true, keyNote: null } }]);
  });

  it('accepts TRUE/FALSE checkbox exports case-insensitively', () => {
    const row = { ...GRADING_ROW, is_correct: 'FALSE', reason: 'wrong gender' };
    const { errors, rows } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([]);
    expect(rows[0].reference.isCorrect).toBe(false);
  });

  it('rejects a malformed is_correct cell', () => {
    const row = { ...GRADING_ROW, is_correct: 'maybe' };
    const { errors } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "Q1: is_correct must be correct/incorrect (got 'maybe')" }]);
  });

  it('requires a reason when is_correct is incorrect', () => {
    const row = { ...GRADING_ROW, is_correct: 'incorrect', reason: '' };
    const { errors } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: 'Q1: reason is required when is_correct is incorrect or borderline is set' }]);
  });

  it('requires a reason when borderline is set', () => {
    const row = { ...GRADING_ROW, borderline: 'yes', reason: '' };
    const { errors } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: 'Q1: reason is required when is_correct is incorrect or borderline is set' }]);
  });

  it('rejects an item_id not in the set and a duplicate', () => {
    const rowUnknown = { ...GRADING_ROW, item_id: 'not-in-set' };
    const { errors: unknownErrors } = validateGradingRows([rowUnknown], KNOWN_IDS);
    expect(unknownErrors).toEqual([{ itemId: 'not-in-set', message: 'Q1: item_id does not belong to this set' }]);

    const { errors: dupErrors, rows } = validateGradingRows([GRADING_ROW, GRADING_ROW], KNOWN_IDS);
    expect(dupErrors).toEqual([{ itemId: 'i-1', message: 'Q1: duplicate item_id' }]);
    expect(rows).toHaveLength(1);
  });
});

describe('validateGradingRows — key_incorrect checkbox group validation', () => {
  const groupIds = new Set(['i-1', 'i-2']);
  const firstRow: CsvRow = { item_id: 'i-1', question_group: 'Q1', key_incorrect: 'TRUE', key_note: 'should accept the plural too', is_correct: 'correct', borderline: '', reason: '' };
  const secondRow: CsvRow = { item_id: 'i-2', question_group: 'Q1', key_incorrect: '', key_note: '', is_correct: 'correct', borderline: '', reason: '' };

  it('is never missing: a group with no checked cell has keyCorrect true', () => {
    const blankFirst: CsvRow = { ...firstRow, key_incorrect: '', key_note: '' };
    const { errors, rows } = validateGradingRows([blankFirst, secondRow], groupIds);
    expect(errors).toEqual([]);
    expect(rows.every((r) => r.reference.keyCorrect === true)).toBe(true);
    expect(rows.every((r) => r.reference.keyNote === null)).toBe(true);
  });

  it('treats TRUE on any row of the group as checked, applying keyCorrect false/key_note to every item', () => {
    const { errors, rows } = validateGradingRows([firstRow, secondRow], groupIds);
    expect(errors).toEqual([]);
    expect(rows.every((r) => r.reference.keyCorrect === false)).toBe(true);
    expect(rows.every((r) => r.reference.keyNote === 'should accept the plural too')).toBe(true);
  });

  it('does not treat FALSE/blank on a non-first row as a disagreement with a TRUE first row', () => {
    // secondRow is FALSE/blank (the normal, expected state for every row but the group's first).
    const { errors } = validateGradingRows([firstRow, secondRow], groupIds);
    expect(errors).toEqual([]);
  });

  it('treats two rows both TRUE as redundant, not a disagreement', () => {
    const bothChecked: CsvRow = { ...secondRow, key_incorrect: 'TRUE', key_note: 'should accept the plural too' };
    const { errors, rows } = validateGradingRows([firstRow, bothChecked], groupIds);
    expect(errors).toEqual([]);
    expect(rows.every((r) => r.reference.keyCorrect === false)).toBe(true);
  });

  it('rejects a malformed key_incorrect cell', () => {
    const malformed: CsvRow = { ...firstRow, key_incorrect: 'sort of' };
    const { errors } = validateGradingRows([malformed, secondRow], groupIds);
    expect(errors).toEqual([{ itemId: 'Q1', message: "key_incorrect must be empty/TRUE/FALSE/yes/no (got 'sort of')" }]);
  });

  it('requires key_note when key_incorrect is checked', () => {
    const noNote: CsvRow = { ...firstRow, key_note: '' };
    const { errors } = validateGradingRows([noNote, secondRow], groupIds);
    expect(errors).toEqual([{ itemId: 'Q1', message: 'key_note is required when key_incorrect is checked' }]);
  });

  it('does not require key_note when key_incorrect is unchecked', () => {
    const unchecked: CsvRow = { ...firstRow, key_incorrect: 'FALSE', key_note: '' };
    const { errors } = validateGradingRows([unchecked, secondRow], groupIds);
    expect(errors).toEqual([]);
  });
});

describe('validateGradingRows — legacy key_correct dropdown (sheets exported before key_incorrect)', () => {
  const groupIds = new Set(['i-1', 'i-2']);
  const firstRow: CsvRow = { item_id: 'i-1', question_ref: 'Q1', key_correct: 'Incorrect', key_note: 'should accept the plural too', is_correct: 'correct', borderline: '', reason: '' };
  const secondRow: CsvRow = { item_id: 'i-2', question_ref: 'Q1', key_correct: '', key_note: '', is_correct: 'correct', borderline: '', reason: '' };

  it('applies the first row\'s key_correct/key_note to every item in the group', () => {
    const { errors, rows } = validateGradingRows([firstRow, secondRow], groupIds);
    expect(errors).toEqual([]);
    expect(rows.every((r) => r.reference.keyCorrect === false)).toBe(true);
    expect(rows.every((r) => r.reference.keyNote === 'should accept the plural too')).toBe(true);
  });

  it('tolerates the key_correct/key_note value appearing on a non-first row of the group', () => {
    const blankFirst: CsvRow = { ...firstRow, key_correct: '', key_note: '' };
    const filledSecond: CsvRow = { ...secondRow, key_correct: 'Correct', key_note: '' };
    const { errors, rows } = validateGradingRows([blankFirst, filledSecond], groupIds);
    expect(errors).toEqual([]);
    expect(rows.every((r) => r.reference.keyCorrect === true)).toBe(true);
  });

  it('rejects a group whose rows disagree on key_correct', () => {
    const conflictingSecond: CsvRow = { ...secondRow, key_correct: 'Correct' };
    const { errors } = validateGradingRows([firstRow, conflictingSecond], groupIds);
    expect(errors).toEqual([{ itemId: 'Q1', message: 'key_correct disagrees between rows of the group' }]);
  });

  it('rejects a group with no key_correct value on any row', () => {
    const blankFirst: CsvRow = { ...firstRow, key_correct: '', key_note: '' };
    const { errors } = validateGradingRows([blankFirst, secondRow], groupIds);
    expect(errors).toEqual([{ itemId: 'Q1', message: 'key_correct is required (missing on every row of the group)' }]);
  });

  it('requires key_note when key_correct is Incorrect', () => {
    const noNote: CsvRow = { ...firstRow, key_note: '' };
    const { errors } = validateGradingRows([noNote, secondRow], groupIds);
    expect(errors).toEqual([{ itemId: 'Q1', message: 'key_note is required when key_correct is Incorrect' }]);
  });

  it('does not require key_note when key_correct is Correct', () => {
    const correctFirst: CsvRow = { ...firstRow, key_correct: 'Correct', key_note: '' };
    const { errors } = validateGradingRows([correctFirst, secondRow], groupIds);
    expect(errors).toEqual([]);
  });
});

describe('isDescriptionRow', () => {
  it('is true when item_id is blank', () => {
    expect(isDescriptionRow({ item_id: '', ref: '1' })).toBe(true);
    expect(isDescriptionRow({ ref: '1' })).toBe(true);
  });

  it('is true when ref is present but not a plain integer', () => {
    expect(isDescriptionRow({ item_id: 'internal id description', ref: 'Row number for referring to this item.' })).toBe(true);
  });

  it('is false for a real data row (numeric ref, non-blank item_id)', () => {
    expect(isDescriptionRow({ item_id: 'i-1', ref: '5' })).toBe(false);
  });

  it('is false when ref is absent entirely, as long as item_id is present', () => {
    expect(isDescriptionRow({ item_id: 'i-1' })).toBe(false);
  });
});

describe('row-context error messages', () => {
  it('prefixes a validation message with ref when the row carries one', () => {
    const row = { ...AUDIT_PASS_ROW, ref: '5', grammar_correct: 'maybe' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "ref 5: grammar_correct must be pass/fail (got 'maybe')" }]);
  });

  it('prefixes a validation message with ref and question_group for a grading row', () => {
    const row = { ...GRADING_ROW, ref: '12', question_group: 'Q3', is_correct: 'nope' };
    const { errors } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "ref 12, Q3: is_correct must be correct/incorrect (got 'nope')" }]);
  });

  it('falls back to question_ref for a grading row from a sheet exported before the question_group rename', () => {
    const row: CsvRow = { item_id: 'i-1', ref: '12', question_ref: 'Q3', key_correct: 'Correct', key_note: '', is_correct: 'nope', borderline: '', reason: '' };
    const { errors } = validateGradingRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "ref 12, Q3: is_correct must be correct/incorrect (got 'nope')" }]);
  });

  it('leaves the message unchanged when the row has no ref or question_group (backward compatible)', () => {
    const row = { ...AUDIT_PASS_ROW, grammar_correct: 'maybe' };
    const { errors } = validateAuditRows([row], KNOWN_IDS);
    expect(errors).toEqual([{ itemId: 'i-1', message: "grammar_correct must be pass/fail (got 'maybe')" }]);
  });
});

function makeItem(id: string, payload: Record<string, unknown>): EvalItemRow {
  return makeEvalItemRow({ id, item_key: id, payload });
}

describe('importing an .xlsx fixture built by eval-review-export', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-review-import-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips the description row and validates the real data rows', async () => {
    const items = [
      makeItem('i-1', { type: 'true-false', difficulty: 'beginner', topic: 'Greetings', question: 'Q1', correct_answer: 'Vrai', options: null, acceptable_variations: null }),
      makeItem('i-2', { type: 'true-false', difficulty: 'beginner', topic: 'Greetings', question: 'Q2', correct_answer: 'Faux', options: null, acceptable_variations: null }),
    ];
    const { rows: exportRows } = buildAuditReferenceRows(items, 1);

    // Fill in the reviewer's verdicts by ref, the way a completed sheet would arrive.
    for (const row of exportRows) {
      row.answer_correct = 'Pass';
      row.grammar_correct = 'Pass';
      row.no_hallucination = 'Pass';
      row.question_coherent = 'Pass';
      row.natural_language = 'Pass';
      row.register_appropriate = 'Pass';
    }

    const buffer = await writeReferenceWorkbook('Audit review', AUDIT_COLUMNS, exportRows);
    const filePath = join(dir, 'completed-audit-reference.xlsx');
    writeFileSync(filePath, buffer);

    const sheetRows = await readXlsxRows(filePath);
    expect(sheetRows).toHaveLength(3); // description row + 2 data rows
    expect(isDescriptionRow(sheetRows[0])).toBe(true);

    const dataRows = sheetRows.filter((r) => !isDescriptionRow(r));
    expect(dataRows).toHaveLength(2);

    const knownIds = new Set(items.map((i) => i.id));
    const { errors, rows } = validateAuditRows(dataRows, knownIds);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.itemId).sort()).toEqual(['i-1', 'i-2']);
  });

  it('reports a validation error by ref when a data row is malformed', async () => {
    const items = [makeItem('i-1', { type: 'true-false', difficulty: 'beginner', topic: 'Greetings', question: 'Q1', correct_answer: 'Vrai', options: null, acceptable_variations: null })];
    const { rows: exportRows } = buildAuditReferenceRows(items, 1);
    exportRows[0].grammar_correct = 'Pass';
    exportRows[0].no_hallucination = 'Pass';
    exportRows[0].question_coherent = 'Pass';
    exportRows[0].natural_language = 'Pass';
    exportRows[0].register_appropriate = 'Pass';
    exportRows[0].answer_correct = 'maybe'; // malformed on purpose

    const buffer = await writeReferenceWorkbook('Audit review', AUDIT_COLUMNS, exportRows);
    const filePath = join(dir, 'malformed-audit-reference.xlsx');
    writeFileSync(filePath, buffer);

    const dataRows = (await readXlsxRows(filePath)).filter((r) => !isDescriptionRow(r));
    const { errors } = validateAuditRows(dataRows, new Set(['i-1']));
    expect(errors).toEqual([{ itemId: 'i-1', message: "ref 1: answer_correct must be pass/fail (got 'maybe')" }]);
  });
});

describe('the --format csv fallback carries the same layout as .xlsx', () => {
  it('round-trips through the description-row skip the same way', () => {
    const items = [makeItem('i-1', { type: 'true-false', difficulty: 'beginner', topic: 'Greetings', question: 'Q1', correct_answer: 'Vrai', options: null, acceptable_variations: null })];
    const { rows: exportRows } = buildAuditReferenceRows(items, 1);
    for (const criterion of ['answer_correct', 'grammar_correct', 'no_hallucination', 'question_coherent', 'natural_language', 'register_appropriate']) {
      exportRows[0][criterion] = 'Pass';
    }

    // Mirrors eval-review-export.ts's writeReferenceCsv(): header row, then the description row, then data.
    const header = AUDIT_COLUMNS.map((c) => c.name);
    const descriptionRow = AUDIT_COLUMNS.map((c) => c.description);
    const dataRow = AUDIT_COLUMNS.map((c) => exportRows[0][c.name] ?? '');
    const csvText = writeCsv(header, [descriptionRow, dataRow]);

    const sheetRows = csvRowsToObjects(parseCsv(csvText));
    expect(sheetRows).toHaveLength(2);
    expect(isDescriptionRow(sheetRows[0])).toBe(true);

    const dataRows = sheetRows.filter((r) => !isDescriptionRow(r));
    expect(dataRows).toHaveLength(1);

    const { errors, rows } = validateAuditRows(dataRows, new Set(['i-1']));
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ itemId: 'i-1', reference: expect.objectContaining({ answer_correct: true }) }]);
  });
});

describe('eval-review-import main()', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'eval-review-import-main-test-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFakeStore(items: EvalItemRow[]): {
    store: EvalStore;
    updateItemCalls: Array<{ id: string; patch: Partial<EvalItemRow> }>;
    insertReviewRoundCalls: NewEvalReviewRoundRow[];
  } {
    const set = makeEvalSetRow({ item_count: items.length });
    const updateItemCalls: Array<{ id: string; patch: Partial<EvalItemRow> }> = [];
    const insertReviewRoundCalls: NewEvalReviewRoundRow[] = [];

    const store: EvalStore = {
      ...baseFakeEvalStore(),
      async getSet(id) { return id === set.id ? set : null; },
      async listItems(setId) { return setId === set.id ? items : []; },
      async updateItem(id, patch) { updateItemCalls.push({ id, patch }); },
      async insertReviewRound(row) {
        insertReviewRoundCalls.push(row);
        return { ...row, id: 'round-1', rubric_hash: row.rubric_hash ?? null, calibration_result: row.calibration_result ?? null, inter_rater: null, reviewed_item_count: row.reviewed_item_count ?? 0, notes: null, created_at: '2026-09-29T00:00:00Z' } as EvalReviewRoundRow;
      },
    };

    return { store, updateItemCalls, insertReviewRoundCalls };
  }

  it('writes reviewed_by and reviewed_at on every row it marks reviewed', async () => {
    const items = [
      makeItem('i-1', { question: 'Q1', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' }),
      makeItem('i-2', { question: 'Q2', submitted_answer: 'b', correct_answer: 'b', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' }),
    ];
    const { store, updateItemCalls } = makeFakeStore(items);

    const csvText = writeCsv(
      ['item_id', 'question_group', 'key_incorrect', 'key_note', 'is_correct', 'borderline', 'reason'],
      [
        ['i-1', 'Q1', '', '', 'correct', '', ''],
        ['i-2', 'Q2', '', '', 'correct', '', ''],
      ],
    );
    const csvPath = join(dir, 'completed-grading-reference.csv');
    writeFileSync(csvPath, csvText);

    await main({ argv: ['--set', 'set-1', '--from', csvPath, '--reviewer', 'jsmith', '--rubric-version', 'v1', '--write-db'], store });

    expect(updateItemCalls).toHaveLength(2);
    for (const call of updateItemCalls) {
      expect(call.patch.reviewed_by).toBe('jsmith');
      expect(typeof call.patch.reviewed_at).toBe('string');
      expect(call.patch.reviewed_at).toBeTruthy();
      expect(call.patch.reference_status).toBe('approved');
    }
    expect(updateItemCalls.map((c) => c.id).sort()).toEqual(['i-1', 'i-2']);
  });

  it('records one eval_review_rounds row with reviewed_item_count matching items actually written, not attempted', async () => {
    const items = [
      makeItem('i-1', { question: 'Q1', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' }),
      makeEvalItemRow({ id: 'i-2', item_key: 'i-2', payload: { question: 'Q2', submitted_answer: 'b', correct_answer: 'b', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' }, reference_status: 'approved' }),
    ];
    const { store, insertReviewRoundCalls } = makeFakeStore(items);

    const csvText = writeCsv(
      ['item_id', 'question_group', 'key_incorrect', 'key_note', 'is_correct', 'borderline', 'reason'],
      [
        ['i-1', 'Q1', '', '', 'correct', '', ''],
        ['i-2', 'Q2', '', '', 'correct', '', ''],
      ],
    );
    const csvPath = join(dir, 'completed-grading-reference-with-skip.csv');
    writeFileSync(csvPath, csvText);

    // i-2 is already approved and --overwrite is not passed, so only i-1 is actually written.
    await main({ argv: ['--set', 'set-1', '--from', csvPath, '--reviewer', 'jsmith', '--rubric-version', 'v1', '--rubric-hash', 'abc123', '--write-db'], store });

    expect(insertReviewRoundCalls).toHaveLength(1);
    expect(insertReviewRoundCalls[0]).toMatchObject({
      set_id: 'set-1',
      reviewer: 'jsmith',
      rubric_version: 'v1',
      rubric_hash: 'abc123',
      reviewed_item_count: 1,
    });
  });

  it('does not record an eval_review_rounds row on a dry run', async () => {
    const items = [
      makeItem('i-1', { question: 'Q1', submitted_answer: 'a', correct_answer: 'a', type: 'fill-in-blank', difficulty: 'easy', label_class: 'correct' }),
    ];
    const { store, insertReviewRoundCalls } = makeFakeStore(items);

    const csvText = writeCsv(
      ['item_id', 'question_group', 'key_incorrect', 'key_note', 'is_correct', 'borderline', 'reason'],
      [['i-1', 'Q1', '', '', 'correct', '', '']],
    );
    const csvPath = join(dir, 'completed-grading-reference-dry-run.csv');
    writeFileSync(csvPath, csvText);

    await main({ argv: ['--set', 'set-1', '--from', csvPath, '--reviewer', 'jsmith', '--rubric-version', 'v1'], store });

    expect(insertReviewRoundCalls).toHaveLength(0);
  });
});
