/**
 * Row shuffling/grouping and column layout for `eval-review-export`'s audit and grading tasks.
 * Pure — no filesystem or workbook writing here; `workbook.ts` turns the columns and rows this
 * module builds into a `.csv` or `.xlsx` file. `review-import.ts` reads the same layout back.
 */

import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { EvalItemRow } from './db';
import { AUDIT_GATE_CRITERIA } from './runner';
import { shuffle, mulberry32 } from './sampling';
import type { ReferenceColumn } from './workbook';

export type ReferenceRow = Record<string, string | number>;

function numberedList(values: string[] | null | undefined): string {
  return values && values.length > 0 ? values.map((v, i) => `${i + 1}. ${v}`).join('\n') : '';
}

function joinedLines(values: string[] | null | undefined): string {
  return values && values.length > 0 ? values.join('\n') : '';
}

/**
 * Prefixes a multiple-choice answer key with the option's 1-based position in `options` (exact text
 * match), so a reviewer can find it in the `options` column at a glance. Any other question type, or
 * a multiple-choice item whose key doesn't match any option's text exactly, returns the bare answer
 * — the caller collects a warning for the latter case rather than this function logging it directly,
 * so the row-building stays side-effect free and testable.
 */
export function auditCorrectAnswerCell(item: EvalItemRow, warnings: string[]): string {
  const p = item.payload;
  const correctAnswer = String(p.correct_answer ?? '');
  if (p.type !== 'multiple-choice') return correctAnswer;

  const options = (p.options as string[] | null) ?? [];
  const index = options.findIndex((o) => o === correctAnswer);
  if (index === -1) {
    warnings.push(`item ${item.id}: no option text matches the answer key exactly; leaving it unprefixed.`);
    return correctAnswer;
  }
  return `${index + 1}. ${correctAnswer}`;
}

export interface BuildAuditReferenceRowsResult {
  rows: ReferenceRow[];
  warnings: string[];
}

/** Shuffles `items` with the seeded RNG and numbers `ref` 1..N after shuffling — the row order a
 * reviewer sees, not the order items were sampled or stored in. */
export function buildAuditReferenceRows(items: EvalItemRow[], seed: number): BuildAuditReferenceRowsResult {
  const warnings: string[] = [];
  const shuffled = shuffle(items, mulberry32(seed));

  const rows = shuffled.map((item, i) => {
    const p = item.payload;
    const row: ReferenceRow = {
      ref: i + 1,
      item_id: item.id,
      type: String(p.type ?? ''),
      difficulty: String(p.difficulty ?? ''),
      topic: String(p.topic ?? ''),
      question: String(p.question ?? ''),
      options: numberedList(p.options as string[] | null),
      answer_key: auditCorrectAnswerCell(item, warnings),
      acceptable_variations: joinedLines(p.acceptable_variations as string[] | null),
      borderline: '',
      reason: '',
    };
    for (const criterion of AUDIT_GATE_CRITERIA) row[criterion] = '';
    return row;
  });

  return { rows, warnings };
}

/**
 * Groups `items` by their source question (`payload.question_id`), then orders the groups and
 * each group's answers with the same seeded RNG stream — questions in random order, each
 * question's answers in random order within its block — so the whole layout is reproducible from
 * one seed. `ref` is numbered 1..N in the final row order; `question_group` (`Q1`..`Qn`) is assigned
 * per group in the order the groups landed after shuffling. `key_incorrect`/`key_note` start blank
 * on every row; `_firstOfGroup` (read by `writeReferenceWorkbook`, not itself an exported column) marks
 * the one row per group where those two cells are unlocked.
 */
export function buildGradingReferenceRows(items: EvalItemRow[], seed: number): ReferenceRow[] {
  const rand = mulberry32(seed);

  const groups = new Map<string, EvalItemRow[]>();
  for (const item of items) {
    const questionId = String(item.payload.question_id ?? '');
    const group = groups.get(questionId);
    if (group) group.push(item);
    else groups.set(questionId, [item]);
  }

  const orderedQuestionIds = shuffle([...groups.keys()], rand);

  const rows: ReferenceRow[] = [];
  let ref = 1;
  orderedQuestionIds.forEach((questionId, groupIndex) => {
    const questionRef = `Q${groupIndex + 1}`;
    const answers = shuffle(groups.get(questionId)!, rand);
    answers.forEach((item, indexInGroup) => {
      const p = item.payload;
      rows.push({
        ref: ref++,
        question_group: questionRef,
        item_id: item.id,
        type: String(p.type ?? ''),
        question: String(p.question ?? ''),
        answer_key: String(p.correct_answer ?? ''),
        key_incorrect: '',
        key_note: '',
        acceptable_variations: joinedLines(p.acceptable_variations as string[] | null),
        student_answer: String(p.submitted_answer ?? ''),
        is_correct: '',
        borderline: '',
        reason: '',
        _firstOfGroup: indexInGroup === 0 ? 1 : 0,
      });
    });
  });

  return rows;
}

const PASS_FAIL: ReferenceColumn['validation'] = ['Pass', 'Fail'];
const BOOLEAN_CHECKBOX: ReferenceColumn['validation'] = ['TRUE', 'FALSE'];

const AUDIT_CRITERION_DESCRIPTIONS: Record<(typeof AUDIT_GATE_CRITERIA)[number], string> = {
  answer_correct:
    "Pass if you agree the answer_key is right: for true/false questions, decide the question "
    + "statement's truth value yourself first; for multiple choice, check that no other option is "
    + `equally correct; for typed questions, ask whether a ${COURSE_CONTENT.language} teacher would accept the answer.`,
  grammar_correct:
    `Pass if the ${COURSE_CONTENT.language} in the question and the key is grammatically correct. Wrong multiple-choice `
    + "options may be ungrammatical on purpose, and informal textbook forms (\"t'as\", \"on va\") are fine.",
  no_hallucination:
    'Pass unless the question or key invents a word, grammar rule, or meaning that does not exist in '
    + `${COURSE_CONTENT.language}. Factual claims about the world are not scored here.`,
  question_coherent:
    'Pass if a student can understand what is being asked and answer it. Fail only for a '
    + 'contradictory, incomplete, or unanswerable question — a question with more than one valid '
    + 'answer is not incoherent.',
  natural_language:
    `Pass if the ${COURSE_CONTENT.language} reads like something a teacher would write for beginners, including `
    + 'regional usage this course teaches. Fail for anglicisms or English word order. Mark Pass if '
    + `there is no ${COURSE_CONTENT.language} in the question or key.`,
  register_appropriate:
    'Pass unless there is a real clash in formality, such as literary tenses in casual dialogue. '
    + 'Informal "tu", slang, and regional expressions are not a fail on their own.',
};

/** Column layout for the audit reference sheet, in export order. */
export const AUDIT_COLUMNS: ReferenceColumn[] = [
  { name: 'ref', description: 'Row #', width: 8 },
  { name: 'item_id', description: 'Internal id used to write your review back to the right item. Hidden and locked; must not be edited.', hidden: true, width: 12 },
  { name: 'type', description: 'Question type: true-false, multiple-choice, fill-in-blank, or writing.', width: 14 },
  { name: 'difficulty', description: "The course's own difficulty label. Hidden — it is not part of this review.", hidden: true, width: 12 },
  { name: 'topic', description: 'The lesson this question comes from, for context only.', width: 22 },
  { name: 'question', description: `The prompt the student sees. It may be in English, ${COURSE_CONTENT.language}, or mixed — that is normal for this course and never a defect by itself.`, wrap: true, width: 44 },
  { name: 'options', description: 'The multiple-choice choices, numbered in the order the student sees them. Judge the question and the answer_key column only — the wrong options are supposed to be wrong.', wrap: true, width: 32 },
  { name: 'answer_key', description: "The correct answer, as determined by AI. For multiple choice, prefixed with the option's number from the options column so you can find it at a glance.", width: 24 },
  { name: 'acceptable_variations', description: 'Other answers scoring also accepts for typed questions. Shown for context only — you are not asked to check them.', wrap: true, width: 32 },
  ...AUDIT_GATE_CRITERIA.map((criterion): ReferenceColumn => ({
    name: criterion,
    description: AUDIT_CRITERION_DESCRIPTIONS[criterion],
    editable: true,
    validation: PASS_FAIL,
    width: 16,
  })),
  { name: 'borderline', description: 'Check when you could have gone either way on any of the six checks.', editable: true, validation: BOOLEAN_CHECKBOX, validationAllowBlank: true, width: 12 },
  { name: 'reason', description: 'One sentence on what is wrong, and the right answer if the key is wrong. Required when any evaluation is Fail or borderline is checked; leave empty otherwise.', wrap: true, editable: true, width: 36 },
];

/** Column layout for the grading reference sheet, in export order. */
export const GRADING_COLUMNS: ReferenceColumn[] = [
  { name: 'ref', description: 'Row #', width: 8 },
  { name: 'question_group', description: "Groups this row with the other answers to the same question (Q1-Q50). Any number of a question's four answers may be correct — do not assume one right and one wrong per group.", width: 12 },
  { name: 'item_id', description: 'Internal id used to write your review back to the right item. Hidden and locked; must not be edited.', hidden: true, width: 12 },
  { name: 'type', description: 'fill-in-blank (a word or short phrase; complete means every blank filled) or writing (a sentence or two; complete means the whole task).', width: 14 },
  { name: 'question', description: 'The prompt the student saw.', wrap: true, width: 44 },
  { name: 'answer_key', description: 'The correct answer, as determined by AI.', width: 22 },
  { name: 'key_incorrect', description: "Is the answer key itself wrong for this question? Check once per question, on the group's first row. If checked, judge every student answer in the group against what you think the key should be, not what's in answer_key.", conditionalEditable: true, validation: BOOLEAN_CHECKBOX, validationAllowBlank: true, width: 16 },
  { name: 'key_note', description: "When key_incorrect is checked: what the key should be, one line. Only on the group's first row.", conditionalEditable: true, wrap: true, width: 32 },
  { name: 'acceptable_variations', description: 'Other answers scoring already accepts; use them to gauge how wide the question is meant to be. An answer not on the list can still be correct, and one on it is not automatically right.', wrap: true, width: 32 },
  { name: 'student_answer', description: 'What the student typed.', wrap: true, width: 32 },
  { name: 'is_correct', description: `Mark Correct or Incorrect: would a ${COURSE_CONTENT.language} teacher accept this answer for this question? Judge against the question, not only the key — meaning and grammar both count. You will not see answers whose only fault is a missing accent or a small typo; scoring handles those separately.`, editable: true, validation: ['Correct', 'Incorrect'], width: 16 },
  { name: 'borderline', description: 'Check when the call was close.', editable: true, validation: BOOLEAN_CHECKBOX, validationAllowBlank: true, width: 12 },
  { name: 'reason', description: 'One phrase on what is wrong (e.g. wrong tense, missing ne). Required for every Incorrect and whenever borderline is checked; leave empty for a clean Correct.', wrap: true, editable: true, width: 36 },
];
