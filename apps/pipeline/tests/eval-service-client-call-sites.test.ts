/**
 * Every eval command reads service-role-only tables, but only writes when `--write-db` is given.
 * A command that hard-codes `write: true` demands a confirmed write target even for a dry run, so
 * each command's `createScriptSupabase` call must take its write flag from the parsed options (or be
 * read-only) and ask for the service role explicitly.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS_DIR } from '../src/lib/paths';

const evalCommands = fs
  .readdirSync(COMMANDS_DIR)
  .filter((file) => /^eval-.*\.ts$/.test(file))
  .filter((file) => fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8').includes('createScriptSupabase('));

describe('eval commands open their Supabase client', () => {
  it('finds the commands that open a client', () => {
    expect(evalCommands.length).toBeGreaterThan(5);
  });

  it.each(evalCommands)('%s asks for the service role and writes only under --write-db', (file) => {
    const source = fs.readFileSync(path.join(COMMANDS_DIR, file), 'utf-8');
    const calls = [...source.matchAll(/createScriptSupabase\(([^)]*)\)/g)].map((m) => m[1]);

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toContain('serviceRole: true');
      expect(args).toMatch(/write: (options\.writeDb|false)/);
    }
  });
});
