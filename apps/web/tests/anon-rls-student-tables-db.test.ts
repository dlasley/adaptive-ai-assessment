/**
 * Proves the anon role has zero SELECT/INSERT/UPDATE/DELETE access to
 * study_codes, quiz_history, question_results, and leitner_state after
 * the RLS-revocation migration. Needs a live connection to the test
 * database — RLS denial semantics aren't uniform across operation types
 * (a denied SELECT returns an empty result, not an error; a denied UPDATE
 * can affect zero rows without erroring), so a mock can't stand in for
 * the real policy engine here.
 *
 * Run this AFTER the RLS migration has been applied to the test project,
 * not before — it asserts the post-migration state and will correctly
 * fail if run too early.
 *
 * Skipped unless RUN_DB_TESTS=1 is set, so `npm test` and CI never touch
 * a database. When set, also requires NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SECRET_KEY pointed at the
 * test project; the test refuses to run against any other host.
 */

import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { getExpectedTestDbHost } from '../../../tests/credential-guard';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN_DB_TESTS)('anon RLS on student tables (real database)', () => {
  it('denies every anon operation against a seeded study_codes fixture', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!url || !anonKey || !secretKey) {
      throw new Error(
        'RUN_DB_TESTS=1 requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SECRET_KEY (test project credentials)'
      );
    }
    if (!url.includes(getExpectedTestDbHost())) {
      throw new Error(`refusing to run against a non-test database host: ${url}`);
    }

    const admin = createClient(url, secretKey);
    const anon = createClient(url, anonKey);

    const code = `rls-test-${Date.now()}`;
    const { data: seeded, error: seedError } = await admin
      .from('study_codes')
      .insert({ code })
      .select('id')
      .single();

    if (seedError || !seeded) {
      throw new Error(`failed to seed test fixture: ${seedError?.message}`);
    }

    const studyCodeId = seeded.id;

    function must<T = unknown>(result: { data: unknown; error: { message: string } | null }, what: string): T {
      if (result.error || result.data === null) {
        throw new Error(`fixture setup failed (${what}): ${result.error?.message ?? 'no data'}`);
      }
      return result.data as T;
    }

    try {
      // Seed one real row in each student table, so every anon check below runs against data that
      // exists rather than passing vacuously on an empty table.
      const question = must<{ id: string; topic: string; difficulty: string; correct_answer: string }>(
        await admin.from('questions').select('id, topic, difficulty, correct_answer').limit(1).single(),
        'pick a question'
      );
      const quiz = must<{ id: string }>(
        await admin
          .from('quiz_history')
          .insert({
            study_code_id: studyCodeId,
            unit_id: 'rls-test',
            difficulty: 'beginner',
            total_questions: 1,
            correct_answers: 1,
            score_percentage: 100,
          })
          .select('id')
          .single(),
        'seed quiz_history'
      );
      must(
        await admin
          .from('question_results')
          .insert({
            quiz_history_id: quiz.id,
            study_code_id: studyCodeId,
            question_id: question.id,
            topic: question.topic,
            difficulty: question.difficulty,
            is_correct: true,
            correct_answer: question.correct_answer,
          })
          .select('id')
          .single(),
        'seed question_results'
      );
      must(
        await admin
          .from('leitner_state')
          .insert({ study_code_id: studyCodeId, question_id: question.id, box: 2, consecutive_correct: 1 })
          .select('question_id')
          .single(),
        'seed leitner_state'
      );

      // 1. Anon SELECT on every student table returns none of the seeded rows.
      const anonStudyCodes = await anon.from('study_codes').select('id').eq('id', studyCodeId);
      expect(anonStudyCodes.data ?? []).toHaveLength(0);
      const anonQuiz = await anon.from('quiz_history').select('id').eq('study_code_id', studyCodeId);
      expect(anonQuiz.data ?? []).toHaveLength(0);
      const anonResults = await anon.from('question_results').select('id').eq('study_code_id', studyCodeId);
      expect(anonResults.data ?? []).toHaveLength(0);
      const anonLeitner = await anon.from('leitner_state').select('question_id').eq('study_code_id', studyCodeId);
      expect(anonLeitner.data ?? []).toHaveLength(0);

      // 2. Anon INSERT adds nothing, verified through the admin client.
      await anon.from('quiz_history').insert({
        study_code_id: studyCodeId,
        unit_id: 'rls-test-anon',
        difficulty: 'beginner',
        total_questions: 1,
        correct_answers: 0,
        score_percentage: 0,
      });
      const quizRows = must<{ id: string }[]>(
        await admin.from('quiz_history').select('id').eq('study_code_id', studyCodeId),
        'reread quiz_history'
      );
      expect(quizRows).toHaveLength(1);

      // 3. Anon UPDATE cannot change is_superuser or a student's Leitner box.
      await anon.from('study_codes').update({ is_superuser: true }).eq('id', studyCodeId);
      const studyCodeRow = must<{ is_superuser: boolean }>(
        await admin.from('study_codes').select('is_superuser').eq('id', studyCodeId).single(),
        'reread study_codes'
      );
      expect(studyCodeRow.is_superuser).toBe(false);

      await anon.from('leitner_state').update({ box: 5 }).eq('study_code_id', studyCodeId);
      const leitnerRow = must<{ box: number }>(
        await admin
          .from('leitner_state')
          .select('box')
          .eq('study_code_id', studyCodeId)
          .eq('question_id', question.id)
          .single(),
        'reread leitner_state after update'
      );
      expect(leitnerRow.box).toBe(2);

      // 4. Anon DELETE removes nothing from any student table.
      await anon.from('leitner_state').delete().eq('study_code_id', studyCodeId);
      await anon.from('question_results').delete().eq('study_code_id', studyCodeId);
      await anon.from('quiz_history').delete().eq('study_code_id', studyCodeId);
      await anon.from('study_codes').delete().eq('id', studyCodeId);
      const survivors = await Promise.all([
        admin.from('leitner_state').select('question_id').eq('study_code_id', studyCodeId),
        admin.from('question_results').select('id').eq('study_code_id', studyCodeId),
        admin.from('quiz_history').select('id').eq('study_code_id', studyCodeId),
        admin.from('study_codes').select('id').eq('id', studyCodeId),
      ]);
      expect(survivors.map((r) => (r.data ?? []).length)).toEqual([1, 1, 1, 1]);
    } finally {
      await admin.from('leitner_state').delete().eq('study_code_id', studyCodeId);
      await admin.from('question_results').delete().eq('study_code_id', studyCodeId);
      await admin.from('quiz_history').delete().eq('study_code_id', studyCodeId);
      await admin.from('study_codes').delete().eq('id', studyCodeId);
    }
  });
});
