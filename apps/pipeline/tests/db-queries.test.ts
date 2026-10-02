import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.fn();
const mockCreateClient = vi.fn((_url: string, _key: string) => ({ from: mockFrom }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string) => mockCreateClient(url, key),
}));

// The real loadEnv() reads the repo-root .env.local, which would refill the variables these tests
// delete in any checkout that has one.
vi.mock('../src/lib/env', () => ({ loadEnv: () => {} }));

import { createScriptSupabase, createServiceReadClient } from '../src/lib/db-queries';

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('createServiceReadClient', () => {
  const ORIGINAL_ENV = { ...process.env };
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCreateClient.mockClear();
    mockFrom.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('exits with a clear error when SUPABASE_SECRET_KEY is missing, instead of falling back to a client that would silently return zero rows', () => {
    delete process.env.SUPABASE_SECRET_KEY;

    expect(() => createServiceReadClient()).toThrow(ProcessExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SUPABASE_SECRET_KEY'));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('exits with a clear error when the Supabase URL is missing', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = 'service-role-secret';

    expect(() => createServiceReadClient()).toThrow(ProcessExitError);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('creates the client with the secret key, never the anon key', () => {
    process.env.SUPABASE_SECRET_KEY = 'service-role-secret';

    createServiceReadClient();

    expect(mockCreateClient).toHaveBeenCalledWith(
      'https://abcdefghijklmnopqrst.supabase.co',
      'service-role-secret',
    );
  });

  it('prints the resolved target before returning the client', () => {
    process.env.SUPABASE_SECRET_KEY = 'service-role-secret';

    createServiceReadClient();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('abcdefghijklmnopqrst'));
  });

  it('exposes only select() from .from(table) — no insert/update/delete, even though the real client has them', () => {
    process.env.SUPABASE_SECRET_KEY = 'service-role-secret';
    const selectResult = { marker: 'select-result' };
    const realFromResult = {
      select: vi.fn(() => selectResult),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      upsert: vi.fn(),
    };
    mockFrom.mockReturnValue(realFromResult);

    const client = createServiceReadClient();
    const table = client.from('llm_batch_jobs');

    // select() still delegates to the real query builder (functionally identical, not the same
    // function reference — it's bound to preserve `this`), and nothing else is reachable.
    expect(table.select()).toBe(selectResult);
    expect(realFromResult.select).toHaveBeenCalledTimes(1);
    expect(table).not.toHaveProperty('insert');
    expect(table).not.toHaveProperty('update');
    expect(table).not.toHaveProperty('delete');
    expect(table).not.toHaveProperty('upsert');
  });
});

describe('createScriptSupabase', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_ARGV = [...process.argv];
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockCreateClient.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SECRET_KEY = 'service-role-secret';
    delete process.env.EXPECTED_SUPABASE_REF;
    process.argv = ORIGINAL_ARGV.filter((arg) => arg !== '--yes-production');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    process.argv = ORIGINAL_ARGV;
  });

  it('reads with the anon key by default', () => {
    createScriptSupabase();

    expect(mockCreateClient).toHaveBeenCalledWith(expect.any(String), 'anon-key');
  });

  it('reads a service-role table with the secret key without a write confirmation', () => {
    createScriptSupabase({ write: false, serviceRole: true });

    expect(mockCreateClient).toHaveBeenCalledWith(expect.any(String), 'service-role-secret');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses an unconfirmed write target, with or without the service-role option', () => {
    expect(() => createScriptSupabase({ write: true })).toThrow(ProcessExitError);
    expect(() => createScriptSupabase({ write: true, serviceRole: true })).toThrow(ProcessExitError);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it.each([
    ['a service-role read', { write: false, serviceRole: true }],
    ['a write', { write: true }],
  ])('exits when SUPABASE_SECRET_KEY is missing for %s instead of using the anon key', (_name, opts) => {
    delete process.env.SUPABASE_SECRET_KEY;
    process.env.EXPECTED_SUPABASE_REF = 'abcdefghijklmnopqrst';

    expect(() => createScriptSupabase(opts)).toThrow(ProcessExitError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SUPABASE_SECRET_KEY'));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
