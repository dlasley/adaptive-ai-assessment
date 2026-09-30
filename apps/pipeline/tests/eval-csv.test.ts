import { describe, expect, it } from 'vitest';
import { csvField, writeCsv, parseCsv, csvRowsToObjects } from '../src/lib/eval/csv';

describe('csvField', () => {
  it('leaves a plain field unquoted', () => {
    expect(csvField('hello')).toBe('hello');
  });

  it('quotes a field containing a comma', () => {
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles an embedded quote', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('passes unicode through unescaped', () => {
    expect(csvField('café — élève 日本語')).toBe('café — élève 日本語');
  });

  it('renders null and undefined as an empty field', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });
});

describe('writeCsv / parseCsv round trip', () => {
  it('round-trips commas, quotes, embedded newlines, and unicode', () => {
    const header = ['a', 'b'];
    const rows = [
      ['plain', '1'],
      ['has,comma', '2'],
      ['has "quote"', '3'],
      ['multi\nline', '4'],
      ['café — élève 日本語', '5'],
    ];
    const csv = writeCsv(header, rows);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(header);
    expect(parsed.slice(1)).toEqual(rows);
  });

  it('parses a quoted field spanning a CRLF-embedded newline', () => {
    const csv = 'a,b\r\n"line1\r\nline2",2\r\n';
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['line1\r\nline2', '2']]);
  });

  it('parses without a trailing newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('csvRowsToObjects', () => {
  it('maps rows to objects keyed by the trimmed header row', () => {
    const rows = [['item_id', ' reason '], ['1', 'ok'], ['2', '']];
    expect(csvRowsToObjects(rows)).toEqual([
      { item_id: '1', reason: 'ok' },
      { item_id: '2', reason: '' },
    ]);
  });

  it('skips a fully blank row', () => {
    const rows = [['item_id', 'reason'], ['1', 'ok'], ['', '']];
    expect(csvRowsToObjects(rows)).toEqual([{ item_id: '1', reason: 'ok' }]);
  });

  it('returns an empty array for a header-only document', () => {
    expect(csvRowsToObjects([['item_id', 'reason']])).toEqual([]);
  });
});
