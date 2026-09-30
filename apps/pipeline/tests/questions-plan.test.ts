import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/questions-plan';

/**
 * Golden-output tests for `questions-plan.ts`'s real `defineCli()`-based parser: each row pins
 * `cli.parse()`'s result for a fixed argv, so a flag silently changing behavior shows up as a diff
 * against the committed expectation instead of needing a second hand-rolled parser to compare
 * against.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

const DEFAULT_TARGET_WRITING = 27;

describe('questions-plan.ts CLI', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEFAULTS = {
    execute: false,
    analyzeOnly: false,
    targetWriting: DEFAULT_TARGET_WRITING,
    verbose: false,
    quiet: false,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'no args (defaults)', args: [], expected: DEFAULTS },
    { name: '--execute', args: ['--execute'], expected: { ...DEFAULTS, execute: true } },
    { name: '--analyze-only', args: ['--analyze-only'], expected: { ...DEFAULTS, analyzeOnly: true } },
    { name: '--target-writing', args: ['--target-writing', '30'], expected: { ...DEFAULTS, targetWriting: 30 } },
    {
      name: 'every flag at once',
      args: ['--execute', '--analyze-only', '--target-writing', '30'],
      expected: { ...DEFAULTS, execute: true, analyzeOnly: true, targetWriting: 30 },
    },
  ];

  it.each(goldenRows)('$name', ({ args, expected }) => {
    expect(cli.parse(args)).toEqual(expected);
  });

  it('--help / -h: prints help and exits 0', () => {
    expect(() => cli.parse(['--help'])).toThrow(ProcessExitError);
    expect(() => cli.parse(['-h'])).toThrow(ProcessExitError);
  });

  it('unknown flag: hard-errors', () => {
    expect(() => cli.parse(['--exceute'])).toThrow(ProcessExitError);
  });

  it('non-numeric --target-writing: hard-errors', () => {
    expect(() => cli.parse(['--target-writing', 'abc'])).toThrow(ProcessExitError);
  });
});
