/**
 * Direct unit tests for `credential-guard.ts`'s exported, synthetic-environment-friendly functions.
 * `applyCredentialGuard` and `getExpectedTestDbHost` both take an injectable `env` object precisely
 * so they can be tested without mutating `process.env` (per the file's own doc comment) — this file
 * exercises that seam, which nothing else in the suite did.
 */

import { describe, expect, it } from 'vitest';
import { applyCredentialGuard, CREDENTIAL_ENV_VARS, getExpectedTestDbHost, type EnvLike } from './credential-guard';

describe('getExpectedTestDbHost', () => {
  it('builds the host from EXPECTED_SUPABASE_REF', () => {
    expect(getExpectedTestDbHost({ EXPECTED_SUPABASE_REF: 'abcxyz' })).toBe('abcxyz.supabase.co');
  });

  it('throws when EXPECTED_SUPABASE_REF is unset', () => {
    expect(() => getExpectedTestDbHost({})).toThrow(/EXPECTED_SUPABASE_REF/);
  });
});

describe('applyCredentialGuard — RUN_DB_TESTS unset (non-DB run)', () => {
  it('strips every credential env var, leaving unrelated vars untouched', () => {
    const env: EnvLike = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://real-project.supabase.co',
      SUPABASE_SECRET_KEY: 'secret',
      SOME_UNRELATED_VAR: 'keep-me',
    };

    applyCredentialGuard(env);

    for (const key of CREDENTIAL_ENV_VARS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.SOME_UNRELATED_VAR).toBe('keep-me');
  });

  it('is a no-op on an already-empty environment', () => {
    const env: EnvLike = {};
    expect(() => applyCredentialGuard(env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe('applyCredentialGuard — RUN_DB_TESTS=1', () => {
  it('leaves credentials in place when NEXT_PUBLIC_SUPABASE_URL matches the expected test host', () => {
    const env: EnvLike = {
      RUN_DB_TESTS: '1',
      EXPECTED_SUPABASE_REF: 'abcxyz',
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcxyz.supabase.co',
      SUPABASE_SECRET_KEY: 'test-secret',
    };

    expect(() => applyCredentialGuard(env)).not.toThrow();
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abcxyz.supabase.co');
    expect(env.SUPABASE_SECRET_KEY).toBe('test-secret');
  });

  it('throws when EXPECTED_SUPABASE_REF is unset', () => {
    const env: EnvLike = {
      RUN_DB_TESTS: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'https://abcxyz.supabase.co',
    };
    expect(() => applyCredentialGuard(env)).toThrow(/EXPECTED_SUPABASE_REF/);
  });

  it('throws when NEXT_PUBLIC_SUPABASE_URL points at a different host than EXPECTED_SUPABASE_REF names', () => {
    const env: EnvLike = {
      RUN_DB_TESTS: '1',
      EXPECTED_SUPABASE_REF: 'abcxyz',
      NEXT_PUBLIC_SUPABASE_URL: 'https://some-other-project.supabase.co',
    };
    expect(() => applyCredentialGuard(env)).toThrow(/refusing to run live-DB tests/i);
  });

  it('throws when NEXT_PUBLIC_SUPABASE_URL is unset entirely', () => {
    const env: EnvLike = { RUN_DB_TESTS: '1', EXPECTED_SUPABASE_REF: 'abcxyz' };
    expect(() => applyCredentialGuard(env)).toThrow(/refusing to run live-DB tests/i);
  });
});
