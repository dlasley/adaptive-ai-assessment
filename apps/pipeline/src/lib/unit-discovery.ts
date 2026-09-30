/**
 * Unit file resolution utilities: finds PDFs and markdown files for a given
 * unit ID.
 *
 * Two resolution paths:
 *   - A unit with a recorded `source_file_stem` (units.source_file_stem in
 *     the DB) resolves directly via resolveUnitPdfPath/resolveUnitMarkdownPath —
 *     no guessing, no course-name dependency.
 *   - A unit without one yet (new, or not upserted since this column was
 *     added) is located by the flexible pattern matching below
 *     (findPdfsForUnit/findMarkdownForUnit), which matches on the unit label
 *     alone so it finds a file regardless of how its course-year prefix is
 *     spelled (e.g. a "2" vs. a roman "II" both match unit-2's pattern). The
 *     pipeline records whatever it finds as source_file_stem when it upserts
 *     the unit, so this path only runs once per unit.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { PDF_DIR, MARKDOWN_DIR } from './paths';

const logger = createLogger('unit-discovery');

export { PDF_DIR, MARKDOWN_DIR };

/** Derive the canonical label from a unit ID (e.g. "unit-2" → "Unit 2", "introduction" → "Introduction") */
export function getUnitLabel(unitId: string): string {
  return unitId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Minimal shape needed to resolve a unit's recorded source file. */
export interface UnitWithSourceFile {
  source_file_stem?: string | null;
}

/** Resolve a unit's PDF from its recorded `source_file_stem`. Null if unrecorded or missing on disk. */
export function resolveUnitPdfPath(unit: UnitWithSourceFile): string | null {
  if (!unit.source_file_stem) return null;
  const p = path.join(PDF_DIR, `${unit.source_file_stem}.pdf`);
  return fs.existsSync(p) ? p : null;
}

/** Resolve a unit's markdown from its recorded `source_file_stem`. Null if unrecorded or missing on disk. */
export function resolveUnitMarkdownPath(unit: UnitWithSourceFile): string | null {
  if (!unit.source_file_stem) return null;
  const p = path.join(MARKDOWN_DIR, `${unit.source_file_stem}.md`);
  return fs.existsSync(p) ? p : null;
}

/**
 * Build a regex pattern that matches filenames for a given unit ID.
 * Matches on the unit label alone (no course prefix) — see the file-level
 * comment. For unit-N IDs, requires the number to be followed by a non-digit
 * (or end of string) to avoid "unit 2" matching "unit 20".
 */
function buildUnitFilePattern(unitId: string): RegExp {
  const label = getUnitLabel(unitId);
  // Extract trailing number if present (e.g. "Unit 2" → "2")
  const trailingNum = label.match(/\d+$/);
  if (trailingNum) {
    // Boundary-safe: require non-digit after the number
    const escaped = label.replace(/\d+$/, '');
    return new RegExp(`${escaped.trim()}[\\s_-]?${trailingNum[0]}(?:\\D|$)`, 'i');
  }
  // No trailing number (e.g. "Introduction") — simple substring match
  return new RegExp(label, 'i');
}

/**
 * Discovery only (see file-level comment): find PDF(s) in PDF_DIR for a unit
 * that has no recorded source_file_stem yet. Returns all PDFs matching the
 * unit pattern, sorted alphabetically.
 */
export function findPdfsForUnit(unitId: string): string[] {
  const matches: string[] = [];

  if (!fs.existsSync(PDF_DIR)) {
    return matches;
  }

  const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  const pattern = buildUnitFilePattern(unitId);

  for (const file of files) {
    if (pattern.test(file)) {
      matches.push(path.join(PDF_DIR, file));
    }
  }

  matches.sort((a, b) => a.localeCompare(b));

  return matches;
}

/**
 * Discovery only (see file-level comment): find a markdown file in
 * MARKDOWN_DIR for a unit that has no recorded source_file_stem yet.
 * Checks explicit conventional paths first (unitId.md, unitId-test.md in
 * test-conversions/), then falls back to pattern matching. Throws on
 * ambiguous pattern matches, returns null if nothing is found.
 */
export function findMarkdownForUnit(unitId: string): string | null {
  // Priority 1: Check explicit paths first (no ambiguity possible)
  const explicitPaths = [
    path.join(MARKDOWN_DIR, `${unitId}.md`),
    path.join(MARKDOWN_DIR, 'test-conversions', `${unitId}-test.md`),
  ];

  for (const p of explicitPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Priority 2: Search by pattern
  const pattern = buildUnitFilePattern(unitId);
  const searchDirs = [MARKDOWN_DIR, path.join(MARKDOWN_DIR, 'test-conversions')];
  const matches: string[] = [];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      if (pattern.test(file)) {
        matches.push(path.join(dir, file));
      }
    }
  }

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    console.log(`  📄 Found markdown via pattern match: ${matches[0]}`);
    return matches[0];
  }

  // Multiple matches - ambiguous, report error
  logger.error(
    `Ambiguous: found ${matches.length} markdown files matching "${unitId}". Rename files or use explicit path with content-suggest-topics.ts directly.`,
    { matches },
  );
  throw new Error(`Ambiguous markdown files for ${unitId}`);
}
