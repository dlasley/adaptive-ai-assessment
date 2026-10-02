/**
 * Proves the anon role reads no rows from the question bank or the unit rows once the anon
 * policies on `questions` and `units` are dropped. A denied SELECT returns an empty result rather
 * than an error, so each check first confirms the service role sees rows in the same table and
 * would pass vacuously otherwise.
 *
 * Run this AFTER the policy-drop migration has been applied to the test project. Skipped unless
 * RUN_DB_TESTS=1; requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
 * SUPABASE_SECRET_KEY for the test project, and refuses any other host.
 */

import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { getExpectedTestDbHost } from '../../../tests/credential-guard';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN_DB_TESTS)('anon RLS on questions and units (real database)', () => {
  it.each(['questions', 'units'])('returns no %s rows to the anon role', async (table) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!url || !anonKey || !secretKey) {
      throw new Error('RUN_DB_TESTS=1 requires the test project URL, anon key and secret key');
    }
    if (!url.includes(getExpectedTestDbHost())) {
      throw new Error(`refusing to run against a non-test database host: ${url}`);
    }

    const seen = await createClient(url, secretKey).from(table).select('id').limit(1);
    expect(seen.error).toBeNull();
    expect(seen.data?.length).toBe(1);

    const anon = await createClient(url, anonKey).from(table).select('id').limit(1);
    expect(anon.data ?? []).toEqual([]);
  });
});
