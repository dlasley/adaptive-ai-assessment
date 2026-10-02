import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cli } from '../src/commands/questions-audit';

/**
 * CLI contract for the merged `questions-audit` command: the `--auditor` option's default and
 * validation, and the cross-flag rules that keep Mistral-only features (batch mode) from being
 * combined with `--auditor sonnet`. Imports the command's real exported `cli` rather than a
 * hand-rolled copy, so this tracks the actual flag spec.
 */

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('questions-audit CLI', () => {
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

  it('defaults --auditor to mistral', () => {
    const options = cli.parse([]);
    expect(options.auditor).toBe('mistral');
  });

  it('accepts --auditor sonnet', () => {
    const options = cli.parse(['--auditor', 'sonnet']);
    expect(options.auditor).toBe('sonnet');
  });

  it('hard-errors on an unrecognized --auditor value', () => {
    expect(() => cli.parse(['--auditor', 'gpt'])).toThrow(ProcessExitError);
  });

  it('parses the flags each auditor reads, camelCased from their kebab-case spellings', () => {
    const options = cli.parse([
      '--auditor', 'sonnet', '--unit', 'unit-2', '--difficulty', 'advanced', '--type', 'writing',
      '--model', 'claude-haiku-4-5', '--limit', '10', '--batch-id', 'b1', '--write-db',
      '--pending-only', '--output', 'out.json',
    ]);
    expect(options.unit).toBe('unit-2');
    expect(options.difficulty).toBe('advanced');
    expect(options.type).toBe('writing');
    expect(options.model).toBe('claude-haiku-4-5');
    expect(options.limit).toBe(10);
    expect(options.batchId).toBe('b1');
    expect(options.writeDb).toBe(true);
    expect(options.pendingOnly).toBe(true);
    expect(options.output).toBe('out.json');
  });

  it('--model with --auditor sonnet is accepted', () => {
    const options = cli.parse(['--auditor', 'sonnet', '--model', 'claude-haiku-4-5']);
    expect(options.model).toBe('claude-haiku-4-5');
  });

  it('--model with the default --auditor (mistral) is rejected — the filter would silently never apply', () => {
    expect(() => cli.parse(['--model', 'claude-haiku-4-5'])).toThrow(ProcessExitError);
  });

  it('--model with --auditor mistral explicitly set is rejected', () => {
    expect(() => cli.parse(['--auditor', 'mistral', '--model', 'claude-haiku-4-5'])).toThrow(ProcessExitError);
  });

  it('--auditor mistral with --llm-batch is accepted', () => {
    const options = cli.parse(['--llm-batch', '--pending-only']);
    expect(options.llmBatch).toBe(true);
  });

  it('--auditor sonnet with --llm-batch is rejected — Sonnet audits synchronously only', () => {
    expect(() => cli.parse(['--auditor', 'sonnet', '--llm-batch'])).toThrow(ProcessExitError);
  });

  it('--auditor sonnet with --llm-batch-resume is rejected', () => {
    expect(() => cli.parse(['--auditor', 'sonnet', '--llm-batch-resume', 'job-123'])).toThrow(ProcessExitError);
  });

  it('--auditor mistral with --llm-batch-resume is accepted', () => {
    const options = cli.parse(['--llm-batch-resume', 'job-123', '--write-db']);
    expect(options.llmBatchResume).toBe('job-123');
  });

  it('--allow-missing-material defaults to false and is parseable', () => {
    expect(cli.parse([]).allowMissingMaterial).toBe(false);
    expect(cli.parse(['--allow-missing-material']).allowMissingMaterial).toBe(true);
  });

  it('--help / -h: prints help and exits 0', () => {
    expect(() => cli.parse(['--help'])).toThrow(ProcessExitError);
    expect(() => cli.parse(['-h'])).toThrow(ProcessExitError);
  });
});
