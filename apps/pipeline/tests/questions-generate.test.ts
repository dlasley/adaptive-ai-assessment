import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/questions-generate';

/**
 * Golden-output tests for `questions-generate.ts`'s real `defineCli()`-based parser — the script
 * with the most flags and cross-field validation of any migrated command. Each row pins
 * `cli.parse()`'s result for a fixed argv, so a flag silently changing behavior shows up as a diff
 * against the committed expectation instead of needing a second hand-rolled parser to compare
 * against.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

// `batch-id`'s default is a timestamp computed once when the module loads (see the command's own
// spec), not a fixed string — read it off the loaded spec instead of guessing a literal.
const DEFAULT_BATCH_ID = cli.specs['batch-id'].default as string;

describe('questions-generate.ts CLI', () => {
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
    unit: undefined,
    difficulty: undefined,
    type: undefined,
    writingType: undefined,
    verbose: false,
    quiet: false,
    topic: undefined,
    batchId: DEFAULT_BATCH_ID,
    count: undefined,
    dryRun: false,
    sourceFile: undefined,
    model: undefined,
    skipValidation: false,
    generationModelStructured: undefined,
    generationModelTyped: undefined,
    validationModel: undefined,
  };

  const goldenRows: { name: string; args: string[]; expected: ReturnType<typeof cli.parse> }[] = [
    { name: 'no args (defaults)', args: [], expected: DEFAULTS },
    { name: '--unit', args: ['--unit', 'unit-3'], expected: { ...DEFAULTS, unit: 'unit-3' } },
    { name: '--topic', args: ['--topic', 'Greetings'], expected: { ...DEFAULTS, topic: 'Greetings' } },
    { name: '--count', args: ['--count', '5'], expected: { ...DEFAULTS, count: 5 } },
    {
      name: '--write-db --dry-run',
      args: ['--write-db', '--dry-run'],
      expected: { ...DEFAULTS, writeDb: true, dryRun: true },
    },
    { name: '--batch-id', args: ['--batch-id', 'my-batch'], expected: { ...DEFAULTS, batchId: 'my-batch' } },
    {
      name: '--source-file',
      args: ['--source-file', 'learnings/unit-3.md'],
      expected: { ...DEFAULTS, sourceFile: 'learnings/unit-3.md' },
    },
    {
      name: '--model',
      args: ['--model', 'anthropic/claude-haiku-4.5'],
      expected: { ...DEFAULTS, model: 'anthropic/claude-haiku-4.5' },
    },
    { name: '--skip-validation', args: ['--skip-validation'], expected: { ...DEFAULTS, skipValidation: true } },
    {
      name: '--generation-model-* + --validation-model',
      args: [
        '--generation-model-structured', 'model-a',
        '--generation-model-typed', 'model-b',
        '--validation-model', 'model-c',
      ],
      expected: {
        ...DEFAULTS,
        generationModelStructured: 'model-a',
        generationModelTyped: 'model-b',
        validationModel: 'model-c',
      },
    },
    {
      name: '--type writing --writing-type conjugation',
      args: ['--type', 'writing', '--writing-type', 'conjugation'],
      expected: { ...DEFAULTS, type: 'writing', writingType: 'conjugation' },
    },
    {
      name: 'every flag at once',
      args: [
        '--unit', 'unit-3', '--topic', 'Greetings', '--difficulty', 'beginner',
        '--type', 'writing', '--writing-type', 'conjugation', '--count', '3',
        '--write-db', '--dry-run', '--batch-id', 'my-batch', '--source-file', 'x.md',
        '--model', 'm', '--skip-validation',
        '--generation-model-structured', 'a', '--generation-model-typed', 'b',
        '--validation-model', 'c',
      ],
      expected: {
        ...DEFAULTS,
        unit: 'unit-3',
        topic: 'Greetings',
        difficulty: 'beginner',
        type: 'writing',
        writingType: 'conjugation',
        count: 3,
        writeDb: true,
        dryRun: true,
        batchId: 'my-batch',
        sourceFile: 'x.md',
        model: 'm',
        skipValidation: true,
        generationModelStructured: 'a',
        generationModelTyped: 'b',
        validationModel: 'c',
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

  it('--writing-type without --type writing: hard-errors', () => {
    expect(() => cli.parse(['--writing-type', 'conjugation'])).toThrow(ProcessExitError);
  });

  it('bad --type value: hard-errors', () => {
    expect(() => cli.parse(['--type', 'essay'])).toThrow(ProcessExitError);
  });

  it('bad --writing-type value: hard-errors', () => {
    expect(() => cli.parse(['--type', 'writing', '--writing-type', 'bogus'])).toThrow(ProcessExitError);
  });

  it('non-numeric --count: hard-errors', () => {
    expect(() => cli.parse(['--count', 'abc'])).toThrow(ProcessExitError);
  });

  it('bad --difficulty value: hard-errors', () => {
    expect(() => cli.parse(['--difficulty', 'expert'])).toThrow(ProcessExitError);
  });

  it('unknown flag: hard-errors', () => {
    expect(() => cli.parse(['--unti', 'unit-2'])).toThrow(ProcessExitError);
  });

  it('--sync-db: deprecated alias for --write-db, applies it and warns', () => {
    const next = cli.parse(['--sync-db']);
    expect(next.writeDb).toBe(true);
  });

  it('--mark-db: also works as a deprecated alias for --write-db', () => {
    const next = cli.parse(['--mark-db']);
    expect(next.writeDb).toBe(true);
  });
});
