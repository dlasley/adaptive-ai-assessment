import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { spawnCommand } from '../src/lib/dispatch/spawn-command';

const mockSpawn = vi.mocked(spawn);

describe('spawnCommand — argv construction and result mapping (mocked spawn)', () => {
  it('resolves the script path from commandsDir and forwards args unmodified, with inherited stdio and no shell', async () => {
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild as never);

    const resultPromise = spawnCommand('questions-generate', ['--unit', 'unit-2', '--write-db'], {
      commandsDir: '/repo/apps/pipeline/src/commands',
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual(
      expect.arrayContaining(['/repo/apps/pipeline/src/commands/questions-generate.ts', '--unit', 'unit-2', '--write-db']),
    );
    expect((options as { stdio?: string }).stdio).toBe('inherit');
    expect((options as { shell?: boolean }).shell).toBeUndefined();

    fakeChild.emit('exit', 0, null);
    await expect(resultPromise).resolves.toEqual({ code: 0, signal: null });
  });

  it('resolves with the exit code and signal the child process reports', async () => {
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild as never);

    const resultPromise = spawnCommand('pipeline-run', [], { commandsDir: '/x' });
    fakeChild.emit('exit', null, 'SIGTERM');

    await expect(resultPromise).resolves.toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('resolves with a failure code instead of rejecting when spawn itself errors', async () => {
    const fakeChild = new EventEmitter();
    mockSpawn.mockReturnValue(fakeChild as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resultPromise = spawnCommand('does-not-matter', [], { commandsDir: '/x' });
    fakeChild.emit('error', new Error('ENOENT'));

    await expect(resultPromise).resolves.toEqual({ code: 1, signal: null });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('does-not-matter'));
    errorSpy.mockRestore();
  });
});
