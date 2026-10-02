import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScriptAsync } from '../src/lib/script-runner';

describe('runScriptAsync', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'script-runner-'));
    process.env.ARGV_OUT = path.join(tmp, 'argv.json');
  });

  afterEach(() => {
    delete process.env.ARGV_OUT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes each argument through as one argument, including values with spaces and shell characters', async () => {
    const args = ['--source-file', 'content/markdown/Unit 1.md', '--batch-id', 'my batch', '--label', '$(echo hi);x'];

    const result = await runScriptAsync('../../tests/fixtures/dispatch/write-argv.ts', args);

    expect(result.success).toBe(true);
    expect(JSON.parse(fs.readFileSync(process.env.ARGV_OUT!, 'utf-8'))).toEqual(args);
  });
});
