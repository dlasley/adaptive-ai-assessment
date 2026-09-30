import { describe, expect, it } from 'vitest';
import {
  buildTranscriptionReferenceExportFiles,
  buildTranscriptionReferenceReadme,
  validateTranscriptionReferenceFiles,
} from '../src/lib/eval/transcription-review';
import { NO_CONTENT_MARKER } from '../src/lib/pdf-conversion';
import type { EvalItemRow } from '../src/lib/eval/db';

function makeItem(overrides: Partial<EvalItemRow> = {}): EvalItemRow {
  return {
    id: `item-${Math.random()}`,
    set_id: 'set-1',
    item_key: 'Unit 1:1',
    payload: { pdf_name: 'Unit 1', slide: 1, category: 'text', text_layer: '', production_flagged: false },
    reference: null,
    reference_status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('buildTranscriptionReferenceExportFiles', () => {
  it('names each file "<slide>.md"', () => {
    const items = [makeItem({ payload: { slide: 5, category: 'text' } }), makeItem({ payload: { slide: 12, category: 'mixed' } })];
    const files = buildTranscriptionReferenceExportFiles(items);
    expect(files.map((f) => f.filename).sort()).toEqual(['12.md', '5.md']);
  });

  it('leaves content empty when no outputsByItem map is given', () => {
    const items = [makeItem({ payload: { slide: 1 } })];
    expect(buildTranscriptionReferenceExportFiles(items)[0].content).toBe('');
  });

  it('prefills content from outputsByItem, keyed by item id', () => {
    const item = makeItem({ id: 'item-a', payload: { slide: 1 } });
    const files = buildTranscriptionReferenceExportFiles([item], new Map([['item-a', '## Baseline transcript']]));
    expect(files[0].content).toBe('## Baseline transcript');
  });

  it('leaves content empty for an item missing from outputsByItem (that variant errored on it)', () => {
    const item = makeItem({ id: 'item-a', payload: { slide: 1 } });
    const files = buildTranscriptionReferenceExportFiles([item], new Map());
    expect(files[0].content).toBe('');
  });
});

describe('buildTranscriptionReferenceReadme', () => {
  it('lists every item sorted by slide, with its category and file name', () => {
    const items = [makeItem({ payload: { slide: 10, category: 'mixed' } }), makeItem({ payload: { slide: 2, category: 'text' } })];
    const readme = buildTranscriptionReferenceReadme('set-1', items);
    const lines = readme.split('\n');
    const row2 = lines.findIndex((l) => l.includes('| 2 |'));
    const row10 = lines.findIndex((l) => l.includes('| 10 |'));
    expect(row2).toBeGreaterThan(-1);
    expect(row10).toBeGreaterThan(row2); // sorted ascending by slide
    expect(readme).toContain('| 2 | text | 2.md |');
    expect(readme).toContain('| 10 | mixed | 10.md |');
  });

  it('mentions the source run when prefilled', () => {
    const readme = buildTranscriptionReferenceReadme('set-1', [makeItem()], 'run-123');
    expect(readme).toContain('run-123');
  });

  it('mentions the no-content marker line for a no-content slide', () => {
    const readme = buildTranscriptionReferenceReadme('set-1', [makeItem()]);
    expect(readme).toContain(NO_CONTENT_MARKER);
  });
});

describe('validateTranscriptionReferenceFiles', () => {
  it('accepts a non-empty file for every item', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } }), makeItem({ id: 'b', payload: { slide: 2 } })];
    const files = new Map([[1, '## Slide 1 content'], [2, '## Slide 2 content']]);
    const { errors, rows } = validateTranscriptionReferenceFiles(items, files);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { itemId: 'a', reference: { markdown: '## Slide 1 content' } },
      { itemId: 'b', reference: { markdown: '## Slide 2 content' } },
    ]);
  });

  it('accepts the exact no-content marker as valid reference', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } })];
    const files = new Map([[1, NO_CONTENT_MARKER]]);
    const { errors, rows } = validateTranscriptionReferenceFiles(items, files);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ itemId: 'a', reference: { markdown: NO_CONTENT_MARKER } }]);
  });

  it('rejects a missing file for an item\'s slide', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } })];
    const { errors, rows } = validateTranscriptionReferenceFiles(items, new Map());
    expect(errors).toHaveLength(1);
    expect(errors[0].itemId).toBe('a');
    expect(errors[0].message).toMatch(/no 1\.md file/);
    expect(rows).toEqual([]);
  });

  it('rejects an empty (or whitespace-only) file', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } })];
    const files = new Map([[1, '   \n  ']]);
    const { errors, rows } = validateTranscriptionReferenceFiles(items, files);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/empty/);
    expect(rows).toEqual([]);
  });

  it('checks every item before returning, reporting every violation at once', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } }), makeItem({ id: 'b', payload: { slide: 2 } })];
    const { errors } = validateTranscriptionReferenceFiles(items, new Map());
    expect(errors).toHaveLength(2);
  });

  it('trims trailing whitespace from a valid file\'s stored reference', () => {
    const items = [makeItem({ id: 'a', payload: { slide: 1 } })];
    const files = new Map([[1, '## Content\n\n']]);
    const { rows } = validateTranscriptionReferenceFiles(items, files);
    expect(rows[0].reference.markdown).toBe('## Content');
  });
});
