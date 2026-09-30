import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DIFFICULTIES, QUESTION_TYPES, WRITING_TYPES } from '../src/enums';

const schema = readFileSync(resolve(__dirname, '../../../supabase/schema.sql'), 'utf-8');

/**
 * Extracts every `<column> IN ('a', 'b', ...)` value list for a given column
 * name from schema.sql's CHECK constraints. The word-boundary keeps, e.g.,
 * `type` from matching inside `resource_type`/`writing_type`.
 */
function extractCheckConstraintValueLists(column: string): string[][] {
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, 'g');
  const occurrences: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(schema)) !== null) {
    occurrences.push(match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
  }
  return occurrences;
}

function expectEnumMatchesSchema(column: string, tsValues: readonly string[]) {
  const occurrences = extractCheckConstraintValueLists(column);
  expect(occurrences.length).toBeGreaterThan(0);
  for (const values of occurrences) {
    expect(new Set(values)).toEqual(new Set(tsValues));
  }
}

describe('shared enums match every CHECK constraint in supabase/schema.sql', () => {
  it('DIFFICULTIES matches every `difficulty IN (...)` constraint', () => {
    expectEnumMatchesSchema('difficulty', DIFFICULTIES);
  });

  it('QUESTION_TYPES matches every `type IN (...)` constraint', () => {
    expectEnumMatchesSchema('type', QUESTION_TYPES);
  });

  it('WRITING_TYPES matches every `writing_type IN (...)` constraint', () => {
    expectEnumMatchesSchema('writing_type', WRITING_TYPES);
  });
});
