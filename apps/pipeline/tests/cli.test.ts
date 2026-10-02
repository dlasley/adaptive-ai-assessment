import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineCli } from '../src/lib/options/define-cli';
import type { OptionSpecs } from '../src/lib/options/types';

describe('defineCli', () => {
  let exitSpy: any;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as unknown as typeof process.exit);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  class ProcessExitError extends Error {
    constructor(public code: number) {
      super(`process.exit(${code})`);
    }
  }

  function expectExit(fn: () => void, code: number) {
    try {
      fn();
      throw new Error('expected process.exit to be called');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExitError);
      expect((err as InstanceType<typeof ProcessExitError>).code).toBe(code);
    }
  }

  const baseSpecs = {
    unit: { type: 'string', help: 'Target unit' },
    count: { type: 'number', default: 10, min: 1, help: 'How many' },
    'write-db': {
      type: 'boolean',
      default: false,
      help: 'Write to DB',
    },
    difficulty: {
      type: 'string',
      choices: ['beginner', 'intermediate', 'advanced'],
      help: 'Difficulty',
    },
  } satisfies OptionSpecs;

  it('applies defaults when nothing is passed', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    const options = cli.parse([]);
    expect(options).toEqual({
      unit: undefined,
      count: 10,
      writeDb: false,
      difficulty: undefined,
    });
  });

  it('parses --flag value for string, number, and boolean types', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    const options = cli.parse(['--unit', 'unit-2', '--count', '5', '--write-db']);
    expect(options.unit).toBe('unit-2');
    expect(options.count).toBe(5);
    expect(options.writeDb).toBe(true);
  });

  it('parses --flag=value syntax identically to --flag value', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    const spaceForm = cli.parse(['--unit', 'unit-2', '--count', '5']);
    const equalsForm = cli.parse(['--unit=unit-2', '--count=5']);
    expect(equalsForm).toEqual(spaceForm);
  });

  it('rejects a value attached to a boolean flag', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--write-db=false']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--write-db is a switch'));
    expectExit(() => cli.parse(['--write-db=text']), 1);
  });

  it('rejects a trailing number or string flag with no value', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--count']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--count needs a value'));
    expectExit(() => cli.parse(['--unit']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--unit needs a value'));
  });

  it('validates choices, hard-erroring on an invalid value', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--difficulty', 'expert']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--difficulty must be one of'));
  });

  it('hard-errors on a non-numeric value for a number flag', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--count', 'not-a-number']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--count must be a valid number'));
  });

  it('hard-errors when a number flag is below its declared minimum', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--count', '0']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--count must be at least 1'));
  });

  it('rejects the retired --sync-db spelling as an unknown option', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--sync-db']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown option: --sync-db'));
  });

  it('hard-errors on an unknown flag by default, naming it and pointing to --help', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--bogus-flag']), 1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown option: --bogus-flag'),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--help'));
  });

  it('treats a dash-prefixed value as the preceding option value, not a flag', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    const options = cli.parse(['--unit', '-5pp improvement expected']);
    expect(options.unit).toBe('-5pp improvement expected');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('sends a negative number to numeric validation instead of the unknown-flag check', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--count', '-5']), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--count must be at least 1'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Unknown option'));
  });

  it('prints help and exits 0 on --help or -h', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse(['--help']), 0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: npx tsx apps/pipeline/src/commands/test-script.ts'));
    expectExit(() => cli.parse(['-h']), 0);
  });

  it('composes group help text mentioning both --flag value and --flag=value', () => {
    const cli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expect(cli.help()).toContain('--flag value` or `--flag=value`');
  });

  it('required fields hard-error when omitted', () => {
    const specs = {
      ...baseSpecs,
      'experiment-id': { type: 'string', required: true, help: 'Experiment id' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, { name: 'test-script', description: 'A test script' });
    expectExit(() => cli.parse([]), 1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--experiment-id is required'));

    const options = cli.parse(['--experiment-id', 'exp-1']);
    expect(options.experimentId).toBe('exp-1');
  });

  it('runs cross-field validate() and fails with its returned message', () => {
    const specs = {
      ...baseSpecs,
      'experiment-id': { type: 'string', help: 'Experiment id' },
      cohort: { type: 'string', help: 'Cohort' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, {
      name: 'test-script',
      description: 'A test script',
      validate: (o) => {
        if (o.experimentId && !o.cohort) return '--experiment-id requires --cohort';
      },
    });

    expectExit(() => cli.parse(['--experiment-id', 'exp-1']), 1);
    expect(errorSpy).toHaveBeenCalledWith('--experiment-id requires --cohort');

    expect(() => cli.parse(['--experiment-id', 'exp-1', '--cohort', 'B'])).not.toThrow();
  });

  it('positional captures the first non-flag argv token as an alternative to its --flag', () => {
    const specs = {
      unit: { type: 'string', positional: true, help: 'Target unit' },
      'write-db': { type: 'boolean', default: false, help: 'Write to DB' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, { name: 'test-script', description: 'A test script' });

    expect(cli.parse(['unit-4']).unit).toBe('unit-4');
    expect(cli.parse(['--unit', 'unit-4']).unit).toBe('unit-4');
    expect(cli.parse(['--write-db', 'unit-4']).unit).toBe('unit-4');
  });

  it('helpOnEmptyArgv prints help and exits 0 on zero args, unlike the default (defaults apply)', () => {
    const defaultCli = defineCli(baseSpecs, { name: 'test-script', description: 'A test script' });
    expect(() => defaultCli.parse([])).not.toThrow();

    const emptyHelpCli = defineCli(baseSpecs, {
      name: 'test-script',
      description: 'A test script',
      helpOnEmptyArgv: true,
    });
    expectExit(() => emptyHelpCli.parse([]), 0);
  });

  it('throws at construction time when two flags claim the same positional slot', () => {
    const specs = {
      unit: { type: 'string', positional: true, help: 'A' },
      topic: { type: 'string', positional: true, help: 'B' },
    } satisfies OptionSpecs;
    expect(() => defineCli(specs, { name: 'test-script', description: 'A test script' })).toThrow(
      /both --unit and --topic declare positional: 1/,
    );
  });

  it('resolves two ordered positionals by their declared slot, independent of key order', () => {
    const specs = {
      'unit-id': { type: 'string', positional: 2, help: 'Unit id' },
      'markdown-file': { type: 'string', positional: 1, help: 'Markdown file' },
      'write-db': { type: 'boolean', default: false, help: 'Write to DB' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, { name: 'test-script', description: 'A test script' });

    const options = cli.parse(['content/unit-4.md', 'unit-4', '--write-db']);
    expect(options.markdownFile).toBe('content/unit-4.md');
    expect(options.unitId).toBe('unit-4');
    expect(options.writeDb).toBe(true);

    // Each positional flag also accepts its explicit --flag form, same as a single-positional spec.
    expect(cli.parse(['--unit-id', 'unit-4', '--markdown-file', 'content/unit-4.md']).unitId).toBe('unit-4');
  });

  it('composes the usage line with every positional in slot order', () => {
    const specs = {
      'unit-id': { type: 'string', positional: 2, help: 'Unit id' },
      'markdown-file': { type: 'string', positional: 1, help: 'Markdown file' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, { name: 'test-script', description: 'A test script' });
    expect(cli.help()).toContain('test-script.ts <markdown-file> <unit-id> [options]');
  });

  it('supports a mode flag that implies zero positionals via cross-field validate()', () => {
    const specs = {
      'unit-id': { type: 'string', positional: 2, help: 'Unit id' },
      'markdown-file': { type: 'string', positional: 1, help: 'Markdown file' },
      consolidate: { type: 'boolean', default: false, help: 'Cross-unit consolidation mode' },
    } satisfies OptionSpecs;
    const cli = defineCli(specs, {
      name: 'test-script',
      description: 'A test script',
      validate: (o) => {
        if (o.consolidate && (o.markdownFile || o.unitId)) {
          return '--consolidate takes no positional arguments';
        }
        if (!o.consolidate && (!o.markdownFile || !o.unitId)) {
          return 'both <markdownFile> and <unitId> are required unless --consolidate is set';
        }
      },
    });

    expect(() => cli.parse(['--consolidate'])).not.toThrow();
    expectExit(() => cli.parse(['content/unit-4.md', 'unit-4', '--consolidate']), 1);
    expect(errorSpy).toHaveBeenCalledWith('--consolidate takes no positional arguments');

    expectExit(() => cli.parse(['content/unit-4.md']), 1);
    expect(errorSpy).toHaveBeenCalledWith(
      'both <markdownFile> and <unitId> are required unless --consolidate is set',
    );

    expect(() => cli.parse(['content/unit-4.md', 'unit-4'])).not.toThrow();
  });
});
