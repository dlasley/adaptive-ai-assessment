/**
 * Minimal RFC 4180 CSV reader/writer for the eval reference review round trip (`eval-review-export` /
 * `eval-review-import`). No external dependency — the project has none for CSV, and the format is
 * small enough to implement correctly: quote a field containing a comma, quote, or newline; double
 * an embedded quote; parse the same back out, including a quoted field that spans multiple lines.
 */

/** Quotes `value` only if it contains a character CSV requires quoting for; doubles any embedded
 * quote. `null`/`undefined` render as an empty field. */
export function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvField).join(',');
}

/** Renders a full CSV document: header row, then one row per entry in `rows`. */
export function writeCsv(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].map((line) => line).join('\n') + '\n';
}

/**
 * Parses CSV text into rows of raw string fields (header row included, at index 0). Handles quoted
 * fields containing commas, embedded (doubled) quotes, and embedded newlines (`\r\n` or `\n`,
 * preserved literally inside a quoted field); a bare `\r` outside quotes is treated as part of a
 * `\r\n` line ending and dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      // Part of a \r\n line ending; the following \n ends the row. A bare \r (classic Mac line
      // ending) is not treated as a row break; spreadsheet exports never produce one.
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  // A trailing newline leaves field==='' and row===[] here — nothing left to flush. Anything else
  // (no trailing newline, or a real blank line mid-file) is a real final row.
  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

/** Maps parsed CSV rows (as `parseCsv` returns them, header included) into objects keyed by the
 * trimmed header row, skipping any row where every field is blank — a trailing blank line is
 * common in a spreadsheet export and isn't a real data row. */
export function csvRowsToObjects(rows: string[][]): Record<string, string>[] {
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  const columns = header.map((h) => h.trim());
  return body
    .filter((row) => row.some((cell) => cell.trim() !== ''))
    .map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i] ?? ''])));
}
