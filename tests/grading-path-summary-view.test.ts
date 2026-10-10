/**
 * Asserts that `supabase/schema.sql` declares the `grading_path_summary` view the README points a
 * reader at, that it runs with the caller's rights, and that it stays the plain aggregate the
 * README describes: grouped by question type, grading path and outcome, and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const schema = readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf-8');

function viewBody(): string {
  const start = schema.indexOf('CREATE VIEW grading_path_summary ');
  expect(start).toBeGreaterThan(-1);
  const end = schema.indexOf(';', start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end + 1);
}

describe('grading_path_summary in supabase/schema.sql', () => {
  it('is declared with security_invoker = true', () => {
    expect(schema).toContain('CREATE VIEW grading_path_summary WITH (security_invoker = true) AS');
  });

  it('carries a COMMENT ON VIEW statement', () => {
    expect(schema).toContain("COMMENT ON VIEW grading_path_summary IS '");
  });

  it('reads question_results joined to questions', () => {
    expect(viewBody()).toContain('FROM question_results r\nJOIN questions q ON q.id = r.question_id');
  });

  it('groups by exactly question type, graded_by and is_correct', () => {
    expect(viewBody()).toMatch(/GROUP BY q\.type, r\.graded_by, r\.is_correct;$/);
  });

  it('selects the columns the README names and nothing else', () => {
    const selectList = viewBody()
      .slice(viewBody().indexOf('SELECT'), viewBody().indexOf('FROM question_results'))
      .split(',')
      .map((part) => part.trim().replace(/^SELECT\s+/, ''))
      .filter(Boolean);
    expect(selectList).toEqual([
      'q.type',
      'r.graded_by',
      'r.is_correct',
      'count(*) AS result_count',
      'min(r.attempted_at) AS first_attempted_at',
      'max(r.attempted_at) AS last_attempted_at',
    ]);
  });

  it('aggregates only a count and the attempt span', () => {
    const body = viewBody();
    expect(body).toContain('count(*) AS result_count');
    expect(body).toContain('min(r.attempted_at) AS first_attempted_at');
    expect(body).toContain('max(r.attempted_at) AS last_attempted_at');
    expect(body.match(/\b(count|min|max|sum|avg|round)\(/g)).toHaveLength(3);
  });
});
