/**
 * Every command in src/commands/ must be import-safe: discovery.ts (and, transitively,
 * completion generation and guided mode) imports each one to read its real `cli`/`commandMeta`
 * export, and none of that may exit the process, create a Supabase client, or read an env file —
 * all three are real things a command's own main() legitimately does when actually run, and all
 * three must only happen behind runIfMain()'s entry guard, never merely from being imported. The
 * env-file assertion is what makes eager course-prompt rendering (the reason four commands used to
 * keep `loadEnv()` at module scope) actually unnecessary: @adaptive/shared/course's `getCourse()`
 * is lazy now, so nothing left in any command needs env populated before main() runs.
 *
 * Credentials are cleared before each import (mirroring "no env set"), so a command whose main()
 * accidentally ran at import time would hit its own missing-credentials branch — which itself
 * calls process.exit(), caught by the same spy this test already asserts against.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listCommandFiles } from '../src/lib/dispatch/discovery';
import { COMMANDS_DIR } from '../src/lib/paths';

const mockCreateClient = vi.fn();
const mockDotenvConfig = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: mockCreateClient,
}));

vi.mock('dotenv', () => ({
  config: mockDotenvConfig,
}));

const CREDENTIAL_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SECRET_KEY',
  'EXPECTED_SUPABASE_REF',
  'OPENROUTER_API_KEY',
];

describe('command modules are import-safe', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of CREDENTIAL_ENV_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockCreateClient.mockClear();
    mockDotenvConfig.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) was called merely by importing this module`);
    }) as never);
  });

  afterEach(() => {
    for (const key of CREDENTIAL_ENV_VARS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    exitSpy.mockRestore();
  });

  const commandNames = listCommandFiles(COMMANDS_DIR);

  it('found the full set of real commands (sanity check for the test itself)', () => {
    expect(commandNames.length).toBeGreaterThanOrEqual(9);
  });

  it.each(commandNames)('%s: importing it calls neither process.exit, createClient, nor dotenv.config', async (name) => {
    const filePath = path.join(COMMANDS_DIR, `${name}.ts`);
    await import(pathToFileURL(filePath).href);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockDotenvConfig).not.toHaveBeenCalled();
  });
});
