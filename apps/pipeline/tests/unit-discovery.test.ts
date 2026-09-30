import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  },
}));

import fs from 'fs';
import {
  getUnitLabel,
  findPdfsForUnit,
  findMarkdownForUnit,
  resolveUnitPdfPath,
  resolveUnitMarkdownPath,
  PDF_DIR,
  MARKDOWN_DIR,
} from '../src/lib/unit-discovery';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

beforeEach(() => {
  mockExistsSync.mockReset();
  mockReaddirSync.mockReset();
});

describe('getUnitLabel', () => {
  it('title-cases a hyphenated unit id', () => {
    expect(getUnitLabel('unit-2')).toBe('Unit 2');
    expect(getUnitLabel('introduction')).toBe('Introduction');
  });
});

describe('resolveUnitPdfPath / resolveUnitMarkdownPath', () => {
  it('resolves directly from a recorded source_file_stem, no pattern matching', () => {
    mockExistsSync.mockImplementation((p) => p === `${PDF_DIR}/Unit 3.pdf`);

    const path = resolveUnitPdfPath({ source_file_stem: 'Unit 3' });

    expect(path).toBe(`${PDF_DIR}/Unit 3.pdf`);
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it('resolves a markdown path the same way', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/Unit 3.md`);

    expect(resolveUnitMarkdownPath({ source_file_stem: 'Unit 3' })).toBe(`${MARKDOWN_DIR}/Unit 3.md`);
  });

  it('returns null when there is no recorded stem', () => {
    expect(resolveUnitPdfPath({ source_file_stem: null })).toBeNull();
    expect(resolveUnitPdfPath({})).toBeNull();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('returns null when the recorded file is missing on disk', () => {
    mockExistsSync.mockReturnValue(false);

    expect(resolveUnitPdfPath({ source_file_stem: 'Unit 3' })).toBeNull();
  });
});

describe('findPdfsForUnit (discovery-only, no recorded stem yet)', () => {
  it('matches a unit regardless of how its course-year prefix is worded', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'Spanish 2 Unit 1.pdf',
      'Spanish II Unit 1.pdf',
      'Spanish 1 Unit 2.pdf', // different unit — must not match
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    const matches = findPdfsForUnit('unit-1').map((m) => m.split('/').pop());

    expect(matches).toEqual(expect.arrayContaining(['Spanish 2 Unit 1.pdf', 'Spanish II Unit 1.pdf']));
    expect(matches).not.toContain('Spanish 1 Unit 2.pdf');
    expect(matches).toHaveLength(2);
  });

  it('does not let "unit 2" match "unit 20"', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Unit 2.pdf', 'Unit 20.pdf'] as unknown as ReturnType<typeof fs.readdirSync>);

    const matches = findPdfsForUnit('unit-2').map((m) => m.split('/').pop());

    expect(matches).toEqual(['Unit 2.pdf']);
  });

  it('returns an empty array when PDF_DIR does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    expect(findPdfsForUnit('unit-1')).toEqual([]);
  });
});

describe('findMarkdownForUnit (discovery-only, no recorded stem yet)', () => {
  it('finds a markdown file named with a non-canonical course prefix', () => {
    mockExistsSync.mockImplementation((p) => p === MARKDOWN_DIR);
    mockReaddirSync.mockImplementation((dir) =>
      dir === MARKDOWN_DIR
        ? (['Spanish 2 Unit 1.md', 'Spanish 1 Unit 3.md'] as unknown as ReturnType<typeof fs.readdirSync>)
        : ([] as unknown as ReturnType<typeof fs.readdirSync>)
    );

    const result = findMarkdownForUnit('unit-1');

    expect(result).toBe(`${MARKDOWN_DIR}/Spanish 2 Unit 1.md`);
  });

  it('prefers the explicit "<unitId>.md" path over pattern matching', () => {
    mockExistsSync.mockImplementation((p) => p === `${MARKDOWN_DIR}/unit-1.md`);

    const result = findMarkdownForUnit('unit-1');

    expect(result).toBe(`${MARKDOWN_DIR}/unit-1.md`);
    expect(mockReaddirSync).not.toHaveBeenCalled();
  });

  it('throws on an ambiguous pattern match', () => {
    mockExistsSync.mockImplementation((p) => p === MARKDOWN_DIR);
    mockReaddirSync.mockImplementation((dir) =>
      dir === MARKDOWN_DIR
        ? (['Spanish 2 Unit 1.md', 'Spanish II Unit 1.md'] as unknown as ReturnType<typeof fs.readdirSync>)
        : ([] as unknown as ReturnType<typeof fs.readdirSync>)
    );

    expect(() => findMarkdownForUnit('unit-1')).toThrow('Ambiguous markdown files for unit-1');
  });

  it('returns null when nothing matches', () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    expect(findMarkdownForUnit('unit-1')).toBeNull();
  });
});
