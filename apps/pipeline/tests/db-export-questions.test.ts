import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/db-export-questions';

/**
 * Golden-output tests for `db-export-questions.ts`'s real `defineCli()`-based parser: each row
 * pins `cli.parse()`'s result for a fixed argv, so a flag silently changing behavior shows up as
 * a diff against the committed expectation instead of needing a second hand-rolled parser to
 * compare against.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('db-export-questions.ts CLI', () => {
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
    output: 'content/exports/corpus-export.json',
    columns: 'minimal' as const,
    unit: undefined,
    difficulty: undefined,
    type: undefined,
    writingType: undefined,
    batchId: undefined,
    verbose: false,
    quiet: false,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'no args (defaults)', args: [], expected: DEFAULTS },
    { name: '--output', args: ['--output', 'data/out.json'], expected: { ...DEFAULTS, output: 'data/out.json' } },
    { name: '--columns full', args: ['--columns', 'full'], expected: { ...DEFAULTS, columns: 'full' } },
    { name: '--unit', args: ['--unit', 'unit-2'], expected: { ...DEFAULTS, unit: 'unit-2' } },
    { name: '--difficulty', args: ['--difficulty', 'beginner'], expected: { ...DEFAULTS, difficulty: 'beginner' } },
    { name: '--type', args: ['--type', 'fill-in-blank'], expected: { ...DEFAULTS, type: 'fill-in-blank' } },
    {
      name: 'every flag at once',
      args: [
        '--output', 'data/out.json',
        '--columns', 'full',
        '--unit', 'unit-2',
        '--difficulty', 'advanced',
        '--type', 'writing',
      ],
      expected: {
        ...DEFAULTS,
        output: 'data/out.json',
        columns: 'full',
        unit: 'unit-2',
        difficulty: 'advanced',
        type: 'writing',
      },
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
    expect(() => cli.parse(['--unti', 'unit-2'])).toThrow(ProcessExitError);
  });

  it('bad --columns value: hard-errors', () => {
    expect(() => cli.parse(['--columns', 'bogus'])).toThrow(ProcessExitError);
  });

  it('bad --difficulty value: hard-errors', () => {
    expect(() => cli.parse(['--difficulty', 'expert'])).toThrow(ProcessExitError);
  });

  it('bad --type value: hard-errors', () => {
    expect(() => cli.parse(['--type', 'essay'])).toThrow(ProcessExitError);
  });
});
