import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `buildAuditMaterialsBlock` reads real files via `loadUnitMaterials` (fs.readFileSync), so `fs`
 * is mocked here the same way `tests/unit-discovery.test.ts` mocks it for the same reason —
 * exercising the real file-resolution code path without touching disk.
 */
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
  },
}));

import fs from 'fs';
import { buildAuditMaterialsBlock, AUDIT_MATERIAL_CHARS_PER_TOPIC } from '../src/lib/learning-materials';
import { MARKDOWN_DIR } from '../src/lib/paths';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

function unit(id: string, topics: { name: string; headings: string[] }[]) {
  return { id, source_file_stem: id, topics };
}

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('buildAuditMaterialsBlock', () => {
  it('returns an empty string for no refs, without touching the filesystem', () => {
    expect(buildAuditMaterialsBlock([], [])).toBe('');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it('includes one labelled section per distinct (unit, topic) pair, deduping repeated refs', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
    mockReadFileSync.mockReturnValue('## Slang\nFerme la trappe! - be quiet\n');
    const units = [unit('unit-1', [{ name: 'Slang', headings: ['Slang'] }])];

    const block = buildAuditMaterialsBlock(
      [
        { unitId: 'unit-1', topic: 'Slang' },
        { unitId: 'unit-1', topic: 'Slang' }, // duplicate ref — same question group, another question on the same topic
      ],
      units,
    );

    expect(block.match(/--- Topic: Slang \(unit-1\) ---/g)).toHaveLength(1);
    expect(block).toContain('Ferme la trappe');
  });

  it('loads a unit\'s markdown once even when the unit has multiple distinct topics in the group', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
    mockReadFileSync.mockReturnValue('## Slang\nFerme la trappe!\n\n## Future Plans\nOn compte faire un tour.\n');
    const units = [unit('unit-1', [
      { name: 'Slang', headings: ['Slang'] },
      { name: 'Future Plans', headings: ['Future Plans'] },
    ])];

    const block = buildAuditMaterialsBlock(
      [{ unitId: 'unit-1', topic: 'Slang' }, { unitId: 'unit-1', topic: 'Future Plans' }],
      units,
    );

    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(block).toContain('--- Topic: Slang (unit-1) ---');
    expect(block).toContain('--- Topic: Future Plans (unit-1) ---');
    expect(block).toContain('On compte faire un tour');
  });

  it('truncates a topic\'s content past maxCharsPerTopic and marks the cut', () => {
    const longSection = `## Big Topic\n${'x'.repeat(200)}\n`;
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
    mockReadFileSync.mockReturnValue(longSection);
    const units = [unit('unit-1', [{ name: 'Big Topic', headings: ['Big Topic'] }])];

    const block = buildAuditMaterialsBlock([{ unitId: 'unit-1', topic: 'Big Topic' }], units, 50);

    expect(block).toContain('[...truncated]');
    // 50 chars of content plus the marker, not the full 200-char section.
    expect(block.length).toBeLessThan(longSection.length);
  });

  it('does not truncate content at or under the cap', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
    mockReadFileSync.mockReturnValue('## Small Topic\nshort content\n');
    const units = [unit('unit-1', [{ name: 'Small Topic', headings: ['Small Topic'] }])];

    const block = buildAuditMaterialsBlock([{ unitId: 'unit-1', topic: 'Small Topic' }], units, AUDIT_MATERIAL_CHARS_PER_TOPIC);

    expect(block).not.toContain('[...truncated]');
    expect(block).toContain('short content');
  });

  it('marks a topic whose headings resolve to nothing, without throwing', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);
    mockReadFileSync.mockReturnValue('## Something Else\ncontent\n');
    const units = [unit('unit-1', [{ name: 'Missing Topic', headings: ['Nonexistent Heading'] }])];

    const block = buildAuditMaterialsBlock([{ unitId: 'unit-1', topic: 'Missing Topic' }], units);

    expect(block).toContain('--- Topic: Missing Topic (unit-1) ---');
    expect(block).toContain('(no source material found for this topic)');
  });

  it('marks a topic whose unit is absent from the given units list, without touching the filesystem', () => {
    const block = buildAuditMaterialsBlock([{ unitId: 'ghost-unit', topic: 'Anything' }], []);

    expect(block).toContain('(no source material found for this topic)');
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});
