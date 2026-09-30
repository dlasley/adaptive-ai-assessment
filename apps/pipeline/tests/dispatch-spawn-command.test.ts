import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { spawnCommand } from '../src/lib/dispatch/spawn-command';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/dispatch');

describe('spawnCommand — end to end (real child process)', () => {
  it('runs a real fixture script and returns its actual exit code', async () => {
    const result = await spawnCommand('echo-argv', ['--foo', 'bar', '--exit-code', '0'], {
      commandsDir: FIXTURES_DIR,
    });
    expect(result).toEqual({ code: 0, signal: null });
  });

  it('propagates a non-zero exit code from the real child process', async () => {
    const result = await spawnCommand('echo-argv', ['--exit-code', '3'], { commandsDir: FIXTURES_DIR });
    expect(result).toEqual({ code: 3, signal: null });
  });
});
