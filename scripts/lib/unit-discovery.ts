/**
 * Unit file resolution utilities.
 *
 * Extracted from regenerate.ts — handles finding PDFs and markdown
 * files for a given unit ID.
 */

import fs from 'fs';
import path from 'path';
import { extractPdfText } from './pdf-conversion';

// Directory paths
const PDF_DIR = path.join(process.cwd(), 'PDF');
const LEARNINGS_DIR = path.join(process.cwd(), 'learnings');

export { PDF_DIR, LEARNINGS_DIR };

/**
 * Find all PDF files for a unit
 * Returns all PDFs matching the unit pattern (canonical first, then others)
 */
export function findPdfsForUnit(unitId: string): string[] {
  const matches: string[] = [];

  if (!fs.existsSync(PDF_DIR)) {
    return matches;
  }

  const files = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));

  // Special case for 'introduction' unit
  if (unitId === 'introduction') {
    const pattern = /introduction/i;
    for (const file of files) {
      if (pattern.test(file)) {
        matches.push(path.join(PDF_DIR, file));
      }
    }
    // Sort with "French 1 Introduction.pdf" first
    matches.sort((a, b) => {
      const aIsCanonical = path.basename(a).toLowerCase() === 'french 1 introduction.pdf';
      const bIsCanonical = path.basename(b).toLowerCase() === 'french 1 introduction.pdf';
      if (aIsCanonical && !bIsCanonical) return -1;
      if (!aIsCanonical && bIsCanonical) return 1;
      return a.localeCompare(b);
    });
    return matches;
  }

  // Standard unit-N pattern handling
  const unitNum = unitId.replace('unit-', '');

  // Pattern requires unit number to be followed by non-digit (or end of string)
  // to avoid "unit 20" matching "unit 2"
  const pattern = new RegExp(`unit[\\s_-]?${unitNum}(?:\\D|$)`, 'i');

  // Sort: canonical first (French 1 Unit X.pdf), then others alphabetically
  const canonical = `French 1 Unit ${unitNum}.pdf`;

  for (const file of files) {
    if (pattern.test(file)) {
      matches.push(path.join(PDF_DIR, file));
    }
  }

  // Sort with canonical first
  matches.sort((a, b) => {
    const aIsCanonical = path.basename(a) === canonical;
    const bIsCanonical = path.basename(b) === canonical;
    if (aIsCanonical && !bIsCanonical) return -1;
    if (!aIsCanonical && bIsCanonical) return 1;
    return a.localeCompare(b);
  });

  return matches;
}

/**
 * Find markdown file for a unit
 * Searches for files containing "unit X" or "unit-X" (case-insensitive)
 * Throws on ambiguous matches, returns null if nothing found
 */
export function findMarkdownForUnit(unitId: string): string | null {
  // Special case for 'introduction' unit
  if (unitId === 'introduction') {
    const explicitPaths = [
      path.join(LEARNINGS_DIR, 'French 1 Introduction.md'),
      path.join(LEARNINGS_DIR, 'introduction.md'),
    ];

    for (const p of explicitPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    // Search for any .md file containing "introduction" in the filename
    const pattern = /introduction/i;
    const searchDirs = [LEARNINGS_DIR, path.join(LEARNINGS_DIR, 'test-conversions')];
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

    if (matches.length === 1) {
      console.log(`  Found markdown via pattern match: ${matches[0]}`);
      return matches[0];
    }
    if (matches.length > 1) {
      console.error(`  Ambiguous: found ${matches.length} markdown files matching "introduction":`);
      for (const m of matches) {
        console.error(`     - ${m}`);
      }
      throw new Error('Ambiguous markdown files for introduction');
    }
    return null;
  }

  // Standard unit-N handling
  const unitNum = unitId.replace('unit-', '');

  // Priority 1: Check explicit paths first (no ambiguity possible)
  const explicitPaths = [
    path.join(LEARNINGS_DIR, `French 1 Unit ${unitNum}.md`),
    path.join(LEARNINGS_DIR, `unit-${unitNum}.md`),
    path.join(LEARNINGS_DIR, 'test-conversions', `unit-${unitNum}-test.md`),
  ];

  for (const p of explicitPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Priority 2: Search for any .md file containing "unit X" or "unit-X" in the filename
  // Pattern requires unit number to be followed by non-digit (or end of string)
  // to avoid "unit 20" matching "unit 2"
  const pattern = new RegExp(`unit[\\s_-]?${unitNum}(?:\\D|$)`, 'i');

  const searchDirs = [LEARNINGS_DIR, path.join(LEARNINGS_DIR, 'test-conversions')];
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
  console.error(`  ❌ Ambiguous: found ${matches.length} markdown files matching "${unitId}":`);
  for (const m of matches) {
    console.error(`     - ${m}`);
  }
  console.error(`  💡 Rename files or use explicit path with suggest-unit-topics.ts directly`);
  throw new Error(`Ambiguous markdown files for ${unitId}`);
}

/**
 * Combine text from multiple PDF files
 */
export function combinePdfTexts(pdfPaths: string[]): string {
  return pdfPaths
    .map(p => extractPdfText(p))
    .join('\n\n');
}
