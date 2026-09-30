/**
 * Generic `.xlsx` mechanics for the eval reference review round trip (`eval-review-export` /
 * `eval-review-import`): writing a reviewer-facing worksheet (headers, a description row, freeze
 * panes, wrap text, hidden columns, dropdown validation, sheet protection) and reading one back
 * into plain string rows. Column *content* (which fields, their descriptions, which are editable)
 * lives in `review-export.ts`; this module only knows how to turn a column layout into workbook
 * bytes and back.
 */

import ExcelJS from 'exceljs';

export interface ReferenceColumn {
  /** Used as both the header cell text (row 1) and the row-object key. */
  name: string;
  /** Row 2 text: what the column is and how the reviewer should or should not use it. */
  description: string;
  hidden?: boolean;
  wrap?: boolean;
  width?: number;
  /** Unlocked on data rows (3..N) once the sheet is protected. Context columns stay locked. */
  editable?: boolean;
  /**
   * Unlocked only on rows whose `_firstOfGroup` value is truthy (a reserved row key read by
   * `writeReferenceWorkbook`, never rendered as its own column). Every other row's cell in this column
   * stays locked and gets a light grey fill, so a reviewer sees at a glance that it isn't meant to
   * be filled. Mutually exclusive with `editable`.
   */
  conditionalEditable?: boolean;
  /** Dropdown list values for an editable column (e.g. `['Pass', 'Fail']`). */
  validation?: string[];
  /** Whether the dropdown allows a blank cell. Defaults to false (required) when `validation` is set. */
  validationAllowBlank?: boolean;
}

/** Fill applied to a `conditionalEditable` column's cell on a row that isn't its group's first —
 * signals at a glance that the cell is locked and not meant to be filled. */
const NON_FIRST_ROW_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };

/**
 * Builds a single-sheet workbook: row 1 bold headers, row 2 italic descriptions (both frozen),
 * one data row per entry in `rows` starting at row 3. Editable columns are unlocked and (when
 * `validation` is set) get a dropdown list; every other cell keeps the default locked state, and
 * the sheet is protected so only the unlocked cells can be edited.
 */
export async function writeReferenceWorkbook(
  sheetName: string,
  columns: ReferenceColumn[],
  rows: Record<string, string | number>[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 2 }] });

  sheet.columns = columns.map((c) => ({ header: c.name, key: c.name, width: c.width ?? 24 }));
  sheet.getRow(1).font = { bold: true };

  const descriptionRow = sheet.addRow(columns.map((c) => c.description));
  descriptionRow.font = { italic: true };

  for (const row of rows) {
    const excelRow = sheet.addRow(columns.map((c) => row[c.name] ?? ''));
    const isFirstOfGroup = row._firstOfGroup !== 0;
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      if (c.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
      if (c.editable || (c.conditionalEditable && isFirstOfGroup)) {
        cell.protection = { locked: false };
        if (c.validation) {
          cell.dataValidation = {
            type: 'list',
            allowBlank: c.validationAllowBlank ?? false,
            formulae: [`"${c.validation.join(',')}"`],
          };
        }
      } else if (c.conditionalEditable && !isFirstOfGroup) {
        cell.fill = NON_FIRST_ROW_FILL;
      }
    });
  }

  columns.forEach((c, i) => {
    if (c.hidden) sheet.getColumn(i + 1).hidden = true;
  });

  // Blank password: the point is to stop an accidental edit to a context column, not to keep a
  // reviewer out of the sheet.
  await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Renders a cell's value as the plain string form the CSV path already produces: a checkbox or
 * boolean-typed cell as `TRUE`/`FALSE`, rich text flattened to its plain text, everything else via
 * `String()`. `null`/`undefined` render as an empty string. */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const rich = value as { richText?: { text: string }[]; text?: string };
    if (rich.richText) return rich.richText.map((t) => t.text).join('');
    if (typeof rich.text === 'string') return rich.text;
  }
  return String(value);
}

/**
 * Reads an `.xlsx` file's first worksheet into row objects keyed by the header row (row 1),
 * mirroring `csv.ts`'s `csvRowsToObjects()` shape so `eval-review-import` can validate either format
 * the same way. Skips a row only when every cell in it is blank — the description row (row 2) is
 * a real row here and is filtered out by the caller (`isDescriptionRow` in `review-import.ts`), not
 * by this reader.
 */
export async function readXlsxRows(filePath: string, sheetName?: string): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  // A tab name is matched exactly, then by prefix: an .xlsx export truncates tab names to 31
  // characters, so "Question check (119 quiz questions)" arrives as "Question check (119 quiz questi".
  const sheet = sheetName === undefined
    ? workbook.worksheets[0]
    : (workbook.getWorksheet(sheetName) ?? workbook.worksheets.find((w) => sheetName.startsWith(w.name) || w.name.startsWith(sheetName)));
  if (!sheet) {
    if (sheetName !== undefined) {
      throw new Error(`No worksheet named "${sheetName}" in ${filePath} (tabs: ${workbook.worksheets.map((w) => w.name).join(', ')})`);
    }
    return [];
  }

  const columnNames: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    columnNames[colNumber - 1] = cellToString(cell.value).trim();
  });

  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const excelRow = sheet.getRow(r);
    const obj: Record<string, string> = {};
    let hasValue = false;
    columnNames.forEach((name, i) => {
      if (!name) return;
      const value = cellToString(excelRow.getCell(i + 1).value);
      obj[name] = value;
      if (value.trim() !== '') hasValue = true;
    });
    if (hasValue) rows.push(obj);
  }
  return rows;
}
