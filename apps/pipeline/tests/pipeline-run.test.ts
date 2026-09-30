import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/pipeline-run';

/**
 * Golden-output tests for `pipeline-run.ts`'s real `defineCli()`-based parser — the CLI script
 * with a positional flag, an ASCII banner, and `helpOnEmptyArgv`. Each row pins `cli.parse()`'s
 * result for a fixed argv, so a flag silently changing behavior shows up as a diff against the
 * committed expectation instead of needing a second hand-rolled parser to compare against. These
 * test the parser's raw output; the script's own `parseArgs()` wrapper derives `unitId` from
 * `all`/`unit` afterward, which is a one-line application-level fallback, not part of the parse.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('pipeline-run.ts CLI', () => {
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
    unit: undefined,
    all: false,
    reviewTopics: false,
    skipConvert: false,
    forceConvert: false,
    skipTopics: false,
    writeDb: false,
    yesProduction: false,
    verbose: false,
    quiet: false,
    audit: false,
    auditor: 'mistral' as const,
    skipResources: false,
    dryRun: false,
    convertOnly: false,
    batchId: undefined,
    markdownFile: undefined,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'unit-4 (positional)', args: ['unit-4'], expected: { ...DEFAULTS, unit: 'unit-4' } },
    { name: '--unit unit-4 (flag)', args: ['--unit', 'unit-4'], expected: { ...DEFAULTS, unit: 'unit-4' } },
    { name: '--all', args: ['--all'], expected: { ...DEFAULTS, all: true } },
    {
      name: 'unit-4 --write-db --audit',
      args: ['unit-4', '--write-db', '--audit'],
      expected: { ...DEFAULTS, unit: 'unit-4', writeDb: true, audit: true },
    },
    {
      name: 'unit-4 --auditor sonnet',
      args: ['unit-4', '--auditor', 'sonnet'],
      expected: { ...DEFAULTS, unit: 'unit-4', auditor: 'sonnet' },
    },
    {
      name: 'unit-4 --skip-convert --force-convert',
      args: ['unit-4', '--skip-convert', '--force-convert'],
      expected: { ...DEFAULTS, unit: 'unit-4', skipConvert: true, forceConvert: true },
    },
    {
      name: 'unit-4 --batch-id --markdown-file',
      args: ['unit-4', '--batch-id', 'b1', '--markdown-file', 'x.md'],
      expected: { ...DEFAULTS, unit: 'unit-4', batchId: 'b1', markdownFile: 'x.md' },
    },
    {
      name: 'every flag at once',
      args: [
        'unit-4', '--review-topics', '--skip-convert', '--force-convert', '--skip-topics',
        '--write-db', '--audit', '--auditor', 'sonnet', '--skip-resources', '--dry-run',
        '--convert-only', '--batch-id', 'b1', '--markdown-file', 'x.md',
      ],
      expected: {
        ...DEFAULTS,
        unit: 'unit-4',
        reviewTopics: true,
        skipConvert: true,
        forceConvert: true,
        skipTopics: true,
        writeDb: true,
        audit: true,
        auditor: 'sonnet',
        skipResources: true,
        dryRun: true,
        convertOnly: true,
        batchId: 'b1',
        markdownFile: 'x.md',
      },
    },
  ];

  it.each(goldenRows)('$name', ({ args, expected }) => {
    expect(cli.parse(args)).toEqual(expected);
  });

  it('positional and --unit flag are equivalent', () => {
    expect(cli.parse(['unit-4'])).toEqual(cli.parse(['--unit', 'unit-4']));
  });

  it('zero args: prints help and exits 0 (helpOnEmptyArgv)', () => {
    expect(() => cli.parse([])).toThrow(ProcessExitError);
  });

  it('--help / -h: prints help and exits 0', () => {
    expect(() => cli.parse(['unit-4', '--help'])).toThrow(ProcessExitError);
  });

  it('--all and a unit id together: hard-errors', () => {
    expect(() => cli.parse(['unit-4', '--all'])).toThrow(ProcessExitError);
  });

  it('invalid --auditor value: hard-errors', () => {
    expect(() => cli.parse(['unit-4', '--auditor', 'bogus'])).toThrow(ProcessExitError);
  });

  it('--audit without --write-db: hard-errors', () => {
    expect(() => cli.parse(['unit-4', '--audit'])).toThrow(ProcessExitError);
  });

  it('unknown flag: hard-errors', () => {
    expect(() => cli.parse(['unit-4', '--wrte-db'])).toThrow(ProcessExitError);
  });

  // The positional slot only captures a genuine non-flag token, so a flag given ahead of the unit
  // id (a natural ordering mistake) doesn't get mistaken for the positional value.
  it('flag before positional (misordered): resolves the unit id correctly', () => {
    expect(cli.parse(['--skip-convert', 'unit-4']).unit).toBe('unit-4');
  });
});
