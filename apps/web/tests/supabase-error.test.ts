import { describe, expect, it } from 'vitest';
import { supabaseErrorFields } from '@/lib/supabase-error';

const MARKER = 'UNMISTAKABLE_ROW_VALUE_MARKER_998877';

describe('supabaseErrorFields', () => {
  it('never returns details, even when details embeds a row value', () => {
    const fields = supabaseErrorFields({
      code: '23505',
      message: 'duplicate key value violates unique constraint "study_codes_code_key"',
      details: `Key (code)=(${MARKER}) already exists.`,
      hint: null,
    });

    expect(fields).not.toHaveProperty('details');
    expect(JSON.stringify(fields)).not.toContain(MARKER);
  });

  it('drops message for an error code whose own message text can embed the invalid value', () => {
    const fields = supabaseErrorFields({
      code: '22P02',
      message: `invalid input syntax for type integer: "${MARKER}"`,
      details: null,
      hint: null,
    });

    expect(fields.message).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain(MARKER);
  });

  it('keeps message for constraint-violation codes verified safe, even when details embeds a value', () => {
    const fields = supabaseErrorFields({
      code: '23502',
      message: 'null value in column "topic" of relation "question_results" violates not-null constraint',
      details: `Failing row contains (id, quiz-id, study-id, question-id, ${MARKER}, difficulty, true).`,
      hint: null,
    });

    expect(fields.message).toContain('violates not-null constraint');
    expect(JSON.stringify(fields)).not.toContain(MARKER);
  });

  it('returns only the name for a non-database Error, never its message', () => {
    const fields = supabaseErrorFields(new Error('network timeout'));

    expect(fields).toEqual({ name: 'Error' });
  });

  it('never returns the input quoted by a JSON parse error', () => {
    let parseError: unknown;
    try {
      JSON.parse('{"userAnswer": STUDENT-MARKER-TEXT');
    } catch (error) {
      parseError = error;
    }

    const fields = supabaseErrorFields(parseError);

    expect(fields).toEqual({ name: 'SyntaxError' });
    expect(JSON.stringify(fields)).not.toContain('STUDENT-MARKER');
  });

  it('returns an empty object for a nullish or unrecognized error value', () => {
    expect(supabaseErrorFields(null)).toEqual({});
    expect(supabaseErrorFields(undefined)).toEqual({});
    expect(supabaseErrorFields('a string')).toEqual({});
  });

  it('passes through hint unconditionally, since Postgres hints never contain row values', () => {
    const fields = supabaseErrorFields({ code: '23505', message: 'dup', hint: 'Try a different value.' });

    expect(fields.hint).toBe('Try a different value.');
  });

  it('drops an empty-string hint rather than including a useless field', () => {
    const fields = supabaseErrorFields({ code: '23505', message: 'dup', hint: '' });

    expect(fields).not.toHaveProperty('hint');
  });

  it('reports code alone for an unrecognized code, dropping message defensively', () => {
    const fields = supabaseErrorFields({
      code: 'PGRST999',
      message: `some future PostgREST message that might embed ${MARKER}`,
    });

    expect(fields).toEqual({ code: 'PGRST999' });
  });
});
