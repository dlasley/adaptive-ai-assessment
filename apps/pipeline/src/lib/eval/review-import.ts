/**
 * Pure validation and reference-row construction for `eval-review-import`: checks a reviewer's rows
 * (already parsed into objects keyed by column name, from either a `.csv` or `.xlsx` sheet) against
 * a set's known item ids and each task's expected cell values, and builds the `eval_items.reference`
 * write shape for every row that passes. No Supabase or filesystem access here —
 * `eval-review-import.ts` reads the sheet and the set's items, and performs the actual write.
 *
 * `ref` and `question_group` (when present) are read only to name a row in an error message; they
 * are never validated or used to look up an item — `item_id` is the sole join key. A sheet exported
 * before the `question_group` rename is still read: `question_ref` is accepted as a fallback wherever
 * `question_group` would be read.
 */

import { AUDIT_GATE_CRITERIA, type AuditGateCriterion } from './runner';

export type CsvRow = Record<string, string>;

export interface ValidationError {
  itemId: string;
  message: string;
}

interface ValidatedRow<G> {
  itemId: string;
  reference: G;
}

export interface ValidationResult<G> {
  errors: ValidationError[];
  rows: ValidatedRow<G>[];
}

export type AuditReferenceRow = Record<AuditGateCriterion, boolean> & {
  borderline: boolean;
  reason: string | null;
};

export interface GradingReferenceRow {
  isCorrect: boolean;
  borderline: boolean;
  reason: string | null;
  keyCorrect: boolean;
  keyNote: string | null;
}

/** Parses a pass/fail-style cell, case-insensitively, also accepting Google Sheets' TRUE/FALSE
 * checkbox export. Returns undefined for anything else. */
function parseTriState(raw: string, truthy: string[], falsy: string[]): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (truthy.includes(v)) return true;
  if (falsy.includes(v)) return false;
  return undefined;
}

const PASS_FAIL_TRUTHY = ['pass', 'true'];
const PASS_FAIL_FALSY = ['fail', 'false'];
const CORRECT_INCORRECT_TRUTHY = ['correct', 'true'];
const CORRECT_INCORRECT_FALSY = ['incorrect', 'false'];

/** Accepted as an alternative sheet header for the `natural_language` criterion. A sheet carrying
 * both headers is refused, since which value the reviewer intended is ambiguous. */
const NATURAL_LANGUAGE_HEADER_ALIAS = 'natural_french';

/** The cell for `criterion`, reading `natural_language` from the alias header when the sheet has no
 * `natural_language` header. */
function auditCriterionCell(row: CsvRow, criterion: AuditGateCriterion): string {
  if (criterion === 'natural_language' && !('natural_language' in row) && NATURAL_LANGUAGE_HEADER_ALIAS in row) {
    return row[NATURAL_LANGUAGE_HEADER_ALIAS] ?? '';
  }
  return row[criterion] ?? '';
}

/** `borderline` accepts empty (defaults to false), TRUE/FALSE, or yes/no — looser than the
 * pass/fail cells since it isn't the primary verdict. */
function parseBorderline(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'false' || v === 'no') return false;
  if (v === 'true' || v === 'yes') return true;
  return undefined;
}

/**
 * True for the export's row-2 description row: `item_id` empty, or `ref` present but not a plain
 * integer. Every real data row from `eval-review-export` always populates both, so either condition
 * is enough to identify the description row in a `.csv` or `.xlsx` reviewer sheet alike.
 */
export function isDescriptionRow(row: CsvRow): boolean {
  const itemId = (row.item_id ?? '').trim();
  if (itemId === '') return true;
  const ref = (row.ref ?? '').trim();
  return ref !== '' && !/^\d+$/.test(ref);
}

/** Prefixes a validation message with the row's `ref`/`question_group`, when the sheet carries
 * them, so a reviewer can find the row without cross-referencing the item id. Older sheets (or
 * direct unit-test rows) without these columns get the message unchanged. */
function withRowContext(row: CsvRow, message: string): string {
  const ref = (row.ref ?? '').trim();
  const questionGroup = (row.question_group ?? row.question_ref ?? '').trim();
  const bits = [ref && `ref ${ref}`, questionGroup].filter((b): b is string => Boolean(b));
  return bits.length > 0 ? `${bits.join(', ')}: ${message}` : message;
}

function checkItemId(
  row: CsvRow,
  knownItemIds: Set<string>,
  seen: Set<string>,
  errors: ValidationError[],
): string | undefined {
  const itemId = (row.item_id ?? '').trim();
  if (!itemId) {
    errors.push({ itemId: '(blank)', message: withRowContext(row, 'item_id is required') });
    return undefined;
  }
  if (!knownItemIds.has(itemId)) {
    errors.push({ itemId, message: withRowContext(row, 'item_id does not belong to this set') });
    return undefined;
  }
  if (seen.has(itemId)) {
    errors.push({ itemId, message: withRowContext(row, 'duplicate item_id') });
    return undefined;
  }
  seen.add(itemId);
  return itemId;
}

/**
 * Validates every row of an audit reference CSV: each of the six gate criteria must be pass/fail,
 * `borderline` must be empty/TRUE/FALSE/yes/no, and `reason` is required whenever any criterion
 * fails or `borderline` is set. Every row is checked before returning, so a caller can report every
 * violation at once rather than stopping at the first.
 */
export function validateAuditRows(rows: CsvRow[], knownItemIds: Set<string>): ValidationResult<AuditReferenceRow> {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  const valid: ValidatedRow<AuditReferenceRow>[] = [];

  const hasBothNaturalLanguageHeaders = rows.some(
    (row) => 'natural_language' in row && NATURAL_LANGUAGE_HEADER_ALIAS in row,
  );
  if (hasBothNaturalLanguageHeaders) {
    errors.push({
      itemId: '(sheet)',
      message: `sheet has both 'natural_language' and '${NATURAL_LANGUAGE_HEADER_ALIAS}' headers — remove the old one`,
    });
    return { errors, rows: valid };
  }

  for (const row of rows) {
    const itemId = checkItemId(row, knownItemIds, seen, errors);
    if (!itemId) continue;

    let rowHasError = false;
    const criteria: Partial<Record<AuditGateCriterion, boolean>> = {};
    let anyFail = false;
    for (const criterion of AUDIT_GATE_CRITERIA) {
      const cell = auditCriterionCell(row, criterion);
      const parsed = parseTriState(cell, PASS_FAIL_TRUTHY, PASS_FAIL_FALSY);
      if (parsed === undefined) {
        errors.push({ itemId, message: withRowContext(row, `${criterion} must be pass/fail (got '${cell}')`) });
        rowHasError = true;
        continue;
      }
      criteria[criterion] = parsed;
      if (!parsed) anyFail = true;
    }

    const borderline = parseBorderline(row.borderline ?? '');
    if (borderline === undefined) {
      errors.push({ itemId, message: withRowContext(row, `borderline must be empty/TRUE/FALSE/yes/no (got '${row.borderline ?? ''}')`) });
      rowHasError = true;
    }

    const reason = (row.reason ?? '').trim();
    if ((anyFail || borderline) && reason === '') {
      errors.push({ itemId, message: withRowContext(row, 'reason is required when any criterion fails or borderline is set') });
      rowHasError = true;
    }

    if (rowHasError) continue;
    valid.push({
      itemId,
      reference: { ...(criteria as Record<AuditGateCriterion, boolean>), borderline: borderline!, reason: reason || null },
    });
  }

  return { errors, rows: valid };
}

/**
 * A group's key verdict (`keyCorrect`/`keyNote` in the written reference), read from whichever rows of
 * the group carry it (the export leaves the cells blank except on the group's first row, but import
 * tolerates a value showing up on any row).
 *
 * Reads the `key_incorrect` checkbox when the sheet has that column: like `borderline`, blank or
 * FALSE means the key is fine, and TRUE on any row of the group means it's wrong — a group is never
 * "missing" a verdict, and FALSE/blank on a non-first row is the normal, expected state rather than
 * a disagreement. A sheet exported before that column existed is still read: when `key_incorrect` is
 * absent, the legacy `key_correct` Correct/Incorrect dropdown is read instead, required on exactly
 * one non-blank row of the group (a group with no value, or with rows that disagree, is a validation
 * error). Either way, `key_note`'s value is read the same way and required whenever the key is wrong.
 * All errors here name the group, not a row.
 */
function validateKeyVerdictGroups(rows: CsvRow[], errors: ValidationError[]): Map<string, { keyCorrect: boolean; keyNote: string | null }> {
  const groupRows = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const questionGroup = (row.question_group ?? row.question_ref ?? '').trim();
    if (!questionGroup) continue;
    const list = groupRows.get(questionGroup) ?? [];
    list.push(row);
    groupRows.set(questionGroup, list);
  }

  const usesKeyIncorrectCheckbox = rows.some((row) => 'key_incorrect' in row);

  const keyByGroup = new Map<string, { keyCorrect: boolean; keyNote: string | null }>();
  for (const [questionGroup, group] of groupRows) {
    let keyCorrect: boolean;
    let rowHasError = false;

    if (usesKeyIncorrectCheckbox) {
      let checked = false;
      for (const row of group) {
        const raw = (row.key_incorrect ?? '').trim();
        if (raw === '') continue;
        const parsed = parseBorderline(raw);
        if (parsed === undefined) {
          errors.push({ itemId: questionGroup, message: `key_incorrect must be empty/TRUE/FALSE/yes/no (got '${raw}')` });
          rowHasError = true;
          continue;
        }
        if (parsed) checked = true;
      }
      keyCorrect = !checked;
    } else {
      const keyCorrectValues = new Set<boolean>();
      let sawKeyCorrectCell = false;
      for (const row of group) {
        const raw = (row.key_correct ?? '').trim();
        if (raw === '') continue;
        sawKeyCorrectCell = true;
        const parsed = parseTriState(raw, CORRECT_INCORRECT_TRUTHY, CORRECT_INCORRECT_FALSY);
        if (parsed === undefined) {
          errors.push({ itemId: questionGroup, message: `key_correct must be correct/incorrect (got '${raw}')` });
          rowHasError = true;
          continue;
        }
        keyCorrectValues.add(parsed);
      }
      if (!rowHasError && !sawKeyCorrectCell) {
        errors.push({ itemId: questionGroup, message: 'key_correct is required (missing on every row of the group)' });
        rowHasError = true;
      } else if (!rowHasError && keyCorrectValues.size > 1) {
        errors.push({ itemId: questionGroup, message: 'key_correct disagrees between rows of the group' });
        rowHasError = true;
      }
      keyCorrect = [...keyCorrectValues][0] ?? true;
    }

    if (rowHasError) continue;

    const keyNoteValues = new Set<string>();
    for (const row of group) {
      const raw = (row.key_note ?? '').trim();
      if (raw !== '') keyNoteValues.add(raw);
    }
    if (keyNoteValues.size > 1) {
      errors.push({ itemId: questionGroup, message: 'key_note disagrees between rows of the group' });
      continue;
    }
    const [keyNote] = keyNoteValues;

    if (keyCorrect === false && !keyNote) {
      const verdictName = usesKeyIncorrectCheckbox ? 'key_incorrect is checked' : 'key_correct is Incorrect';
      errors.push({ itemId: questionGroup, message: `key_note is required when ${verdictName}` });
      continue;
    }

    keyByGroup.set(questionGroup, { keyCorrect, keyNote: keyNote ?? null });
  }

  return keyByGroup;
}

/**
 * Validates every row of a grading reference CSV: `is_correct` must be correct/incorrect, `borderline`
 * must be empty/TRUE/FALSE/yes/no, `reason` is required whenever `is_correct` is incorrect or
 * `borderline` is set, and every `question_group` group carries a key verdict (see
 * `validateKeyVerdictGroups`) — read from whichever row of the group has it, not necessarily the
 * first.
 */
export function validateGradingRows(rows: CsvRow[], knownItemIds: Set<string>): ValidationResult<GradingReferenceRow> {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  const perItem: { itemId: string; questionGroup: string; isCorrect: boolean; borderline: boolean; reason: string | null }[] = [];

  for (const row of rows) {
    const itemId = checkItemId(row, knownItemIds, seen, errors);
    if (!itemId) continue;

    let rowHasError = false;
    const isCorrect = parseTriState(row.is_correct ?? '', CORRECT_INCORRECT_TRUTHY, CORRECT_INCORRECT_FALSY);
    if (isCorrect === undefined) {
      errors.push({ itemId, message: withRowContext(row, `is_correct must be correct/incorrect (got '${row.is_correct ?? ''}')`) });
      rowHasError = true;
    }

    const borderline = parseBorderline(row.borderline ?? '');
    if (borderline === undefined) {
      errors.push({ itemId, message: withRowContext(row, `borderline must be empty/TRUE/FALSE/yes/no (got '${row.borderline ?? ''}')`) });
      rowHasError = true;
    }

    const reason = (row.reason ?? '').trim();
    if ((isCorrect === false || borderline) && reason === '') {
      errors.push({ itemId, message: withRowContext(row, 'reason is required when is_correct is incorrect or borderline is set') });
      rowHasError = true;
    }

    if (rowHasError) continue;
    perItem.push({ itemId, questionGroup: (row.question_group ?? row.question_ref ?? '').trim(), isCorrect: isCorrect!, borderline: borderline!, reason: reason || null });
  }

  const keyByGroup = validateKeyVerdictGroups(rows, errors);

  const valid: ValidatedRow<GradingReferenceRow>[] = [];
  for (const item of perItem) {
    const key = keyByGroup.get(item.questionGroup);
    if (!key) continue; // the group's own key verdict error is already recorded above
    valid.push({
      itemId: item.itemId,
      reference: { isCorrect: item.isCorrect, borderline: item.borderline, reason: item.reason, keyCorrect: key.keyCorrect, keyNote: key.keyNote },
    });
  }

  return { errors, rows: valid };
}
