import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/db-seed-study-code-words';

/**
 * Golden-output tests for `db-seed-study-code-words.ts`'s real `defineCli()`-based parser: each
 * row pins `cli.parse()`'s result for a fixed argv, so a flag silently changing behavior shows up
 * as a diff against the committed expectation instead of needing a second hand-rolled parser to
 * compare against.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('db-seed-study-code-words.ts CLI', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEFAULTS = {
    writeDb: false,
    yesProduction: false,
    count: 200,
    dryRun: false,
    verbose: false,
    quiet: false,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'no args (defaults)', args: [], expected: DEFAULTS },
    { name: '--count', args: ['--count', '50'], expected: { ...DEFAULTS, count: 50 } },
    { name: '--write-db', args: ['--write-db'], expected: { ...DEFAULTS, writeDb: true } },
    {
      name: '--write-db --dry-run',
      args: ['--write-db', '--dry-run'],
      expected: { ...DEFAULTS, writeDb: true, dryRun: true },
    },
    { name: '--dry-run alone (writeDb stays false)', args: ['--dry-run'], expected: { ...DEFAULTS, dryRun: true } },
    {
      name: 'every flag at once',
      args: ['--count', '75', '--write-db', '--dry-run'],
      expected: { ...DEFAULTS, count: 75, writeDb: true, dryRun: true },
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
    expect(() => cli.parse(['--bogus'])).toThrow(ProcessExitError);
  });

  it('bad --count value (NaN): hard-errors', () => {
    expect(() => cli.parse(['--count', 'abc'])).toThrow(ProcessExitError);
  });

  it('--count below the minimum (0): hard-errors', () => {
    expect(() => cli.parse(['--count', '0'])).toThrow(ProcessExitError);
  });
});
