/**
 * Strips live credentials from process.env before the test suite runs, so `npm test` is offline by
 * construction regardless of what a developer's shell has exported (e.g. sourcing
 * `.env.test.local` for manual pipeline work, per the project's documented workflow).
 *
 * `RUN_DB_TESTS=1` is the one path that needs real credentials — a handful of tests connect to the
 * test database directly (see `llm-batch-jobs-db.test.ts`, `anon-rls-student-tables-db.test.ts`),
 * gated behind `describe.skipIf(!RUN_DB_TESTS)` and reading `process.env` themselves inside `it()`.
 * That path is left untouched here, but only after confirming the resolved Supabase URL is the
 * test project — never the production one — so a misconfigured `RUN_DB_TESTS=1` run fails loudly
 * instead of quietly running live-DB tests against the wrong database.
 */

// tests/setup.ts reruns this guard in a global `beforeEach`, which strips these vars again before
// every single test body. Setting one of them in a `beforeAll` (rather than each test's own
// `beforeEach`, the pattern every current test uses) would have it silently cleared again before
// the first `it()` runs, with no error — just a confusingly-undefined credential.
export const CREDENTIAL_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'EXPECTED_SUPABASE_REF',
  'OPENROUTER_API_KEY',
  'ADMIN_PASSWORD',
  'ADMIN_SESSION_SECRET',
  'STUDENT_SESSION_SECRET',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'TURNSTILE_SECRET_KEY',
] as const;

/** A plain string-keyed env-like object — looser than `NodeJS.ProcessEnv`, which requires `NODE_ENV`, so tests can pass a minimal synthetic environment. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Builds the expected test-database host from `EXPECTED_SUPABASE_REF`, so no test file hardcodes a
 * project ref. Throws rather than falling back to a default when the variable is unset, since a
 * silent fallback would let `RUN_DB_TESTS=1` run against whatever host happens to be configured.
 */
export function getExpectedTestDbHost(env: EnvLike = process.env): string {
  const ref = env.EXPECTED_SUPABASE_REF;
  if (!ref) {
    throw new Error(
      'RUN_DB_TESTS=1 requires EXPECTED_SUPABASE_REF to be set to the test Supabase project ref.'
    );
  }
  return `${ref}.supabase.co`;
}

/**
 * Applies the guard to the given environment (`process.env` by default). Exported separately from
 * its call site so the stripping and RUN_DB_TESTS logic can be unit-tested against a synthetic
 * environment without mutating the real process state.
 */
export function applyCredentialGuard(env: EnvLike = process.env): void {
  if (env.RUN_DB_TESTS === '1') {
    const expectedHost = getExpectedTestDbHost(env);
    const url = env.NEXT_PUBLIC_SUPABASE_URL;
    if (!url || !url.includes(expectedHost)) {
      throw new Error(
        `RUN_DB_TESTS=1 requires NEXT_PUBLIC_SUPABASE_URL to point at the test database host ` +
          `(${expectedHost}); refusing to run live-DB tests against an unexpected or missing target.`
      );
    }
    return;
  }

  for (const name of CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
}
