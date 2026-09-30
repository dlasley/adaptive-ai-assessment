import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/content-extract-resources';

/**
 * Golden-output tests for `content-extract-resources.ts`'s real `defineCli()`-based parser: each
 * row pins `cli.parse()`'s result for a fixed argv, so a flag silently changing behavior shows up
 * as a diff against the committed expectation instead of needing a second hand-rolled parser to
 * compare against. These test the parser's raw output only — the dry-run-unless-write-db
 * resolution in the script's own `main()` is application logic layered on top, not part of the CLI
 * parse itself.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('content-extract-resources.ts CLI', () => {
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
    unit: undefined,
    writeDb: false,
    yesProduction: false,
    dryRun: false,
    force: false,
    verbose: false,
    quiet: false,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'no args (defaults)', args: [], expected: DEFAULTS },
    { name: '--unit', args: ['--unit', 'unit-2'], expected: { ...DEFAULTS, unit: 'unit-2' } },
    { name: '--write-db', args: ['--write-db'], expected: { ...DEFAULTS, writeDb: true } },
    {
      name: '--write-db --dry-run',
      args: ['--write-db', '--dry-run'],
      expected: { ...DEFAULTS, writeDb: true, dryRun: true },
    },
    { name: '--force', args: ['--force'], expected: { ...DEFAULTS, force: true } },
    {
      name: 'every flag at once',
      args: ['--unit', 'unit-2', '--write-db', '--dry-run', '--force'],
      expected: { ...DEFAULTS, unit: 'unit-2', writeDb: true, dryRun: true, force: true },
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
});
