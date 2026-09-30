/**
 * Proves the applied_at atomic-claim guard under genuine Postgres concurrency. Needs a live
 * connection to the test database, not a mock — a mocked fetch has no concurrency semantics to
 * prove anything about row-level atomicity.
 *
 * Skipped unless RUN_DB_TESTS=1 is set, so `npm test` and CI never touch a database. When set,
 * also requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY pointed at the test project;
 * the test refuses to run against any other host.
 */

import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { getExpectedTestDbHost } from '../../../tests/credential-guard';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN_DB_TESTS)('llm_batch_jobs applied_at claim guard (real database)', () => {
  it('lets exactly one of two genuinely concurrent claims on the same row succeed', async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;

    if (!url || !secretKey) {
      throw new Error(
        'RUN_DB_TESTS=1 requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (test project credentials)'
      );
    }
    if (!url.includes(getExpectedTestDbHost())) {
      throw new Error(`refusing to run against a non-test database host: ${url}`);
    }

    const supabase = createClient(url, secretKey);

    const { data: inserted, error: insertError } = await supabase
      .from('llm_batch_jobs')
      .insert({
        provider_batch_id: `test-concurrency-${Date.now()}`,
        stage: 'audit',
        pipeline_batch_id: 'test-concurrency',
        model: 'mistralai/mistral-large-2512',
        custom_id_context: {},
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      throw new Error(`failed to insert test row: ${insertError?.message}`);
    }

    try {
      const claim = () =>
        supabase
          .from('llm_batch_jobs')
          .update({ applied_at: new Date().toISOString() })
          .eq('id', inserted.id)
          .is('applied_at', null)
          .select('id');

      const [first, second] = await Promise.all([claim(), claim()]);

      const claimedCount = (first.data?.length ?? 0) + (second.data?.length ?? 0);
      expect(claimedCount).toBe(1);
    } finally {
      await supabase.from('llm_batch_jobs').delete().eq('id', inserted.id);
    }
  });
});
