import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const schema = readFileSync(resolve(__dirname, '../../../supabase/schema.sql'), 'utf-8');

/** Tables a stranger holding the public anon key must not be able to read. */
const TABLES_WITHOUT_ANON_POLICY = [
  'study_codes',
  'quiz_history',
  'question_results',
  'leitner_state',
  'questions',
  'units',
  'study_code_source_words',
];

describe('anon policies in supabase/schema.sql', () => {
  it.each(TABLES_WITHOUT_ANON_POLICY)('%s has no policy for the anon role', (table) => {
    const policies = [...schema.matchAll(/CREATE POLICY\s+"[^"]+"\s+ON\s+(\w+)\b([^;]*);/g)].filter(
      ([, policyTable, rest]) => policyTable === table && /\bTO\s+anon\b/.test(rest)
    );
    expect(policies).toEqual([]);
  });

  it('keeps the anon read of learning_resources, the one table the browser reads directly', () => {
    expect(schema).toMatch(/CREATE POLICY "anon_select_learning_resources"\s+ON learning_resources FOR SELECT\s+TO anon/);
  });
});

describe('retired study code helpers', () => {
  it.each(['generate_study_code', 'calculate_overall_stats'])('%s is not defined', (name) => {
    expect(schema).not.toContain(name);
  });
});
