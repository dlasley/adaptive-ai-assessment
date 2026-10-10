import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  DIFFICULTIES,
  EVAL_TASKS,
  EXPERIMENT_STATUSES,
  FINDING_KINDS,
  GRADED_BY_VALUES,
  QUESTION_TYPES,
  REFERENCE_STATUSES,
  RUN_STATUSES,
  WRITING_TYPES,
} from '../src/enums';

const schema = readFileSync(resolve(__dirname, '../../../supabase/schema.sql'), 'utf-8');

/**
 * Returns the text of `CREATE TABLE <name> (...)`, up to the statement's closing `);` at the start
 * of a line.
 */
function extractTableBlock(table: string): string {
  const start = schema.indexOf(`CREATE TABLE ${table} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf('\n);', start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

/**
 * Extracts every `<column> IN ('a', 'b', ...)` value list for a given column
 * name from schema.sql's CHECK constraints, optionally limited to one table's
 * CREATE TABLE block. The word-boundary keeps, e.g., `type` from matching
 * inside `resource_type`/`writing_type`.
 */
function extractCheckConstraintValueLists(column: string, table?: string): string[][] {
  const text = table ? extractTableBlock(table) : schema;
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`, 'g');
  const occurrences: string[][] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    occurrences.push(match[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')));
  }
  return occurrences;
}

function expectEnumMatchesSchema(column: string, tsValues: readonly string[], table?: string) {
  const occurrences = extractCheckConstraintValueLists(column, table);
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

  it('GRADED_BY_VALUES matches `graded_by IN (...)` on question_results', () => {
    expectEnumMatchesSchema('graded_by', GRADED_BY_VALUES, 'question_results');
  });

  it('EVAL_TASKS matches every `task IN (...)` constraint', () => {
    expectEnumMatchesSchema('task', EVAL_TASKS);
  });

  it('EVAL_TASKS matches the eval_experiments.tasks array literal', () => {
    const block = extractTableBlock('eval_experiments');
    const match = /tasks\s*<@\s*ARRAY\[([^\]]*)\]/.exec(block);
    expect(match).not.toBeNull();
    const values = match![1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    expect(new Set(values)).toEqual(new Set(EVAL_TASKS));
  });

  it('FINDING_KINDS matches `kind IN (...)` on eval_findings', () => {
    expectEnumMatchesSchema('kind', FINDING_KINDS, 'eval_findings');
  });

  it('REFERENCE_STATUSES matches `reference_status IN (...)`', () => {
    expectEnumMatchesSchema('reference_status', REFERENCE_STATUSES);
  });

  it('RUN_STATUSES matches `status IN (...)` on eval_runs', () => {
    expectEnumMatchesSchema('status', RUN_STATUSES, 'eval_runs');
  });

  it('EXPERIMENT_STATUSES matches `status IN (...)` on eval_experiments', () => {
    expectEnumMatchesSchema('status', EXPERIMENT_STATUSES, 'eval_experiments');
  });
});
