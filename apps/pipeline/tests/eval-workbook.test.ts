import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ExcelJS from 'exceljs';
import { writeReferenceWorkbook, readXlsxRows, type ReferenceColumn } from '../src/lib/eval/workbook';
import { AUDIT_COLUMNS, GRADING_COLUMNS, buildAuditReferenceRows, buildGradingReferenceRows } from '../src/lib/eval/review-export';
import { AUDIT_GATE_CRITERIA } from '../src/lib/eval/runner';
import type { EvalItemRow } from '../src/lib/eval/db';

function makeItem(id: string, payload: Record<string, unknown>): EvalItemRow {
  return {
    id,
    set_id: 'set-1',
    item_key: id,
    payload,
    seeded_class: null,
    reference: null,
    reference_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    created_at: '',
    updated_at: '',
  };
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-workbook-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeReferenceWorkbook / readXlsxRows round trip', () => {
  const items = [
    makeItem('i-1', {
      type: 'multiple-choice',
      difficulty: 'beginner',
      topic: 'Greetings',
      question: 'Comment ça va?',
      options: ['Bien', 'Mal', 'Comme ci comme ça'],
      correct_answer: 'Comme ci comme ça',
      acceptable_variations: null,
    }),
    makeItem('i-2', {
      type: 'true-false',
      difficulty: 'advanced',
      topic: 'Verbs',
      question: 'Vrai ou faux: "je suis" is the present tense of être.',
      options: null,
      correct_answer: 'Vrai',
      acceptable_variations: null,
    }),
  ];

  let filePath: string;

  beforeAll(async () => {
    const { rows } = buildAuditReferenceRows(items, 1);
    const buffer = await writeReferenceWorkbook('Audit review', AUDIT_COLUMNS, rows);
    filePath = join(dir, 'audit-reference.xlsx');
    writeFileSync(filePath, buffer);
  });

  it('writes bold headers in column order on row 1', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const headerValues = AUDIT_COLUMNS.map((_, i) => sheet.getRow(1).getCell(i + 1).value);
    expect(headerValues).toEqual(AUDIT_COLUMNS.map((c) => c.name));
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  it('writes the italic per-column description on row 2', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const descriptionValues = AUDIT_COLUMNS.map((_, i) => sheet.getRow(2).getCell(i + 1).value);
    expect(descriptionValues).toEqual(AUDIT_COLUMNS.map((c) => c.description));
    expect(sheet.getRow(2).font?.italic).toBe(true);
  });

  it('freezes rows 1 and 2', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
  });

  it('hides item_id and difficulty', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const itemIdIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'item_id');
    const difficultyIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'difficulty');
    const topicIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'topic');
    expect(sheet.getColumn(itemIdIndex + 1).hidden).toBe(true);
    expect(sheet.getColumn(difficultyIndex + 1).hidden).toBe(true);
    expect(sheet.getColumn(topicIndex + 1).hidden).toBeFalsy();
  });

  it('applies a Pass/Fail dropdown to the six criteria and protects the sheet', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const criterionIndex = AUDIT_COLUMNS.findIndex((c) => c.name === AUDIT_GATE_CRITERIA[0]);
    const cell = sheet.getCell(3, criterionIndex + 1);
    expect(cell.dataValidation).toMatchObject({ type: 'list', formulae: ['"Pass,Fail"'] });
    expect(cell.protection).toMatchObject({ locked: false });
    expect((sheet as unknown as { sheetProtection?: unknown }).sheetProtection).toBeTruthy();
  });

  it('locks context columns (rows 3..N) while leaving input columns unlocked', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const topicIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'topic');
    const reasonIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'reason');
    const topicCell = sheet.getCell(3, topicIndex + 1);
    const reasonCell = sheet.getCell(3, reasonIndex + 1);
    // A locked cell's protection is left at the workbook default (undefined here), not explicitly
    // set — only cells this module marks `editable` get an explicit unlocked protection entry.
    expect(topicCell.protection?.locked).not.toBe(false);
    expect(reasonCell.protection).toMatchObject({ locked: false });
  });

  it('wraps text on the long context and free-text columns', async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const questionIndex = AUDIT_COLUMNS.findIndex((c) => c.name === 'question');
    expect(sheet.getCell(3, questionIndex + 1).alignment?.wrapText).toBe(true);
  });

  it('reads answer_key back with the option-number prefix for multiple choice', async () => {
    const rows = await readXlsxRows(filePath);
    const row = rows.find((r) => r.item_id === 'i-1')!;
    expect(row.answer_key).toBe('3. Comme ci comme ça');
    const trueFalseRow = rows.find((r) => r.item_id === 'i-2')!;
    expect(trueFalseRow.answer_key).toBe('Vrai');
  });
});

describe('grading workbook: question_group grouping is deterministic under a seed', () => {
  const items = [
    makeItem('q1-a', { question_id: 'q1', type: 'writing', question: 'Q1', correct_answer: 'x', submitted_answer: 'x' }),
    makeItem('q1-b', { question_id: 'q1', type: 'writing', question: 'Q1', correct_answer: 'x', submitted_answer: 'y' }),
    makeItem('q2-a', { question_id: 'q2', type: 'fill-in-blank', question: 'Q2', correct_answer: 'z', submitted_answer: 'z' }),
    makeItem('q2-b', { question_id: 'q2', type: 'fill-in-blank', question: 'Q2', correct_answer: 'z', submitted_answer: 'w' }),
  ];

  it('produces the same ref/question_group assignment on every write for the same seed', async () => {
    const rowsA = buildGradingReferenceRows(items, 5);
    const rowsB = buildGradingReferenceRows(items, 5);
    const bufferA = await writeReferenceWorkbook('Grading review', GRADING_COLUMNS, rowsA);
    const bufferB = await writeReferenceWorkbook('Grading review', GRADING_COLUMNS, rowsB);

    const pathA = join(dir, 'grading-a.xlsx');
    const pathB = join(dir, 'grading-b.xlsx');
    writeFileSync(pathA, bufferA);
    writeFileSync(pathB, bufferB);

    const readBack = async (p: string) => (await readXlsxRows(p)).map((r) => ({ ref: r.ref, question_group: r.question_group, item_id: r.item_id }));
    expect(await readBack(pathA)).toEqual(await readBack(pathB));
  });

  it('applies the Correct/Incorrect dropdown to is_correct', async () => {
    const rows = buildGradingReferenceRows(items, 1);
    const buffer = await writeReferenceWorkbook('Grading review', GRADING_COLUMNS, rows);
    const filePath = join(dir, 'grading-validation.xlsx');
    writeFileSync(filePath, buffer);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const isCorrectIndex = GRADING_COLUMNS.findIndex((c) => c.name === 'is_correct');
    expect(sheet.getCell(3, isCorrectIndex + 1).dataValidation).toMatchObject({
      type: 'list',
      formulae: ['"Correct,Incorrect"'],
    });
  });

  it('places key_incorrect/key_note immediately after answer_key and before acceptable_variations', () => {
    const names = GRADING_COLUMNS.map((c) => c.name);
    const answerKeyIdx = names.indexOf('answer_key');
    expect(names[answerKeyIdx + 1]).toBe('key_incorrect');
    expect(names[answerKeyIdx + 2]).toBe('key_note');
    expect(names[answerKeyIdx + 3]).toBe('acceptable_variations');
  });

  it("unlocks key_incorrect/key_note only on each group's first row, greying out the rest", async () => {
    const rows = buildGradingReferenceRows(items, 5);
    const buffer = await writeReferenceWorkbook('Grading review', GRADING_COLUMNS, rows);
    const filePath = join(dir, 'grading-key-columns.xlsx');
    writeFileSync(filePath, buffer);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.worksheets[0];
    const keyIncorrectIndex = GRADING_COLUMNS.findIndex((c) => c.name === 'key_incorrect');
    const keyNoteIndex = GRADING_COLUMNS.findIndex((c) => c.name === 'key_note');

    const firstRowIndex = rows.findIndex((r) => r._firstOfGroup === 1);
    const secondRowIndex = rows.findIndex((r) => r._firstOfGroup === 0);
    const firstSheetRow = firstRowIndex + 3; // row 1: headers, row 2: descriptions, row 3+: data
    const secondSheetRow = secondRowIndex + 3;

    const firstKeyIncorrectCell = sheet.getCell(firstSheetRow, keyIncorrectIndex + 1);
    expect(firstKeyIncorrectCell.protection).toMatchObject({ locked: false });
    expect(firstKeyIncorrectCell.dataValidation).toMatchObject({ type: 'list', formulae: ['"TRUE,FALSE"'] });
    expect((firstKeyIncorrectCell.fill as { pattern?: string } | undefined)?.pattern).not.toBe('solid');

    const secondKeyIncorrectCell = sheet.getCell(secondSheetRow, keyIncorrectIndex + 1);
    expect(secondKeyIncorrectCell.protection?.locked).not.toBe(false);
    expect(secondKeyIncorrectCell.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } });

    const secondKeyNoteCell = sheet.getCell(secondSheetRow, keyNoteIndex + 1);
    expect(secondKeyNoteCell.protection?.locked).not.toBe(false);
    expect(secondKeyNoteCell.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } });
  });
});

describe('readXlsxRows', () => {
  it('renders a boolean-typed cell as TRUE/FALSE, matching the CSV convention', async () => {
    const columns: ReferenceColumn[] = [
      { name: 'item_id', description: '' },
      { name: 'borderline', description: '', editable: true, validation: ['TRUE', 'FALSE'] },
    ];
    const buffer = await writeReferenceWorkbook('Sheet1', columns, [{ item_id: 'i-1', borderline: '' }]);
    const filePath = join(dir, 'boolean-cell.xlsx');
    writeFileSync(filePath, buffer);

    // Simulate a reviewer ticking a checkbox-style TRUE value by writing an actual boolean into
    // the cell, the way a spreadsheet's checkbox format would store it.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    workbook.worksheets[0].getCell(3, 2).value = true;
    await workbook.xlsx.writeFile(filePath);

    const rows = await readXlsxRows(filePath);
    expect(rows[0].borderline).toBe('TRUE');
  });

  it('skips a fully blank row, matching csvRowsToObjects', async () => {
    const columns: ReferenceColumn[] = [{ name: 'item_id', description: '' }, { name: 'reason', description: '', editable: true }];
    const buffer = await writeReferenceWorkbook('Sheet1', columns, [
      { item_id: 'i-1', reason: 'ok' },
      { item_id: '', reason: '' },
    ]);
    const filePath = join(dir, 'blank-row.xlsx');
    writeFileSync(filePath, buffer);

    const rows = await readXlsxRows(filePath);
    expect(rows).toHaveLength(1);
    expect(rows[0].item_id).toBe('i-1');
  });
});
