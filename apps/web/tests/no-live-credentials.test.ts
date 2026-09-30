import { describe, expect, it } from 'vitest';
import { applyCredentialGuard, CREDENTIAL_ENV_VARS, getExpectedTestDbHost, type EnvLike } from '../../../tests/credential-guard';
import { isSupabaseAvailable } from '@/lib/supabase';
import { isSupabaseAdminAvailable } from '@/lib/supabase-admin';

describe('applyCredentialGuard', () => {
  it('strips every tracked credential from a polluted environment, simulating a shell where .env.local was exported', () => {
    const fakeEnv: EnvLike = {};
    for (const name of CREDENTIAL_ENV_VARS) fakeEnv[name] = 'leaked-value';

    applyCredentialGuard(fakeEnv);

    for (const name of CREDENTIAL_ENV_VARS) {
      expect(fakeEnv[name]).toBeUndefined();
    }
  });

  it('leaves unrelated env vars untouched', () => {
    const fakeEnv: EnvLike = { NODE_ENV: 'test', SOME_OTHER_VAR: 'keep-me' };

    applyCredentialGuard(fakeEnv);

    expect(fakeEnv.NODE_ENV).toBe('test');
    expect(fakeEnv.SOME_OTHER_VAR).toBe('keep-me');
  });

  it('preserves credentials when RUN_DB_TESTS=1 and the URL points at the test database host', () => {
    const fakeEnv: EnvLike = {
      RUN_DB_TESTS: '1',
      EXPECTED_SUPABASE_REF: 'test-project-ref',
      NEXT_PUBLIC_SUPABASE_URL: 'https://test-project-ref.supabase.co',
      SUPABASE_SECRET_KEY: 'test-secret',
      OPENROUTER_API_KEY: 'test-openrouter-key',
    };

    applyCredentialGuard(fakeEnv);

    expect(fakeEnv.SUPABASE_SECRET_KEY).toBe('test-secret');
    expect(fakeEnv.OPENROUTER_API_KEY).toBe('test-openrouter-key');
  });

  it('refuses RUN_DB_TESTS=1 against a non-test database host', () => {
    const fakeEnv: EnvLike = {
      RUN_DB_TESTS: '1',
      EXPECTED_SUPABASE_REF: 'test-project-ref',
      NEXT_PUBLIC_SUPABASE_URL: 'https://some-production-project.supabase.co',
      SUPABASE_SECRET_KEY: 'a-real-secret',
    };

    expect(() => applyCredentialGuard(fakeEnv)).toThrow(/test database host/);
  });

  it('refuses RUN_DB_TESTS=1 with no Supabase URL at all', () => {
    const fakeEnv: EnvLike = { RUN_DB_TESTS: '1', EXPECTED_SUPABASE_REF: 'test-project-ref' };

    expect(() => applyCredentialGuard(fakeEnv)).toThrow(/test database host/);
  });

  it('refuses RUN_DB_TESTS=1 when EXPECTED_SUPABASE_REF is unset', () => {
    const fakeEnv: EnvLike = { RUN_DB_TESTS: '1' };

    expect(() => applyCredentialGuard(fakeEnv)).toThrow(/EXPECTED_SUPABASE_REF/);
  });

  it('has already stripped every tracked credential from process.env by the time this test runs', () => {
    for (const name of CREDENTIAL_ENV_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
  });

  it('leaves the app with no configured Supabase client in the default (non-DB) test run', () => {
    expect(isSupabaseAvailable()).toBe(false);
    expect(isSupabaseAdminAvailable()).toBe(false);
  });
});

describe('getExpectedTestDbHost', () => {
  it('builds the expected host from EXPECTED_SUPABASE_REF', () => {
    expect(getExpectedTestDbHost({ EXPECTED_SUPABASE_REF: 'test-project-ref' })).toBe(
      'test-project-ref.supabase.co'
    );
  });

  it('throws naming EXPECTED_SUPABASE_REF when it is unset', () => {
    expect(() => getExpectedTestDbHost({})).toThrow(/EXPECTED_SUPABASE_REF/);
  });
});
