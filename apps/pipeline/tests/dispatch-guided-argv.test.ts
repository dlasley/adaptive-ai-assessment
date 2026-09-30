import { describe, expect, it } from 'vitest';
import { answersToArgv, formatCommandLine } from '../src/lib/dispatch/guided-argv';
import type { OptionSpecs } from '../src/lib/options/types';

const SPECS: OptionSpecs = {
  unit: { type: 'string', help: 'Unit id' },
  all: { type: 'boolean', default: false, help: 'Process every unit' },
  count: { type: 'number', default: 10, help: 'How many' },
  'write-db': { type: 'boolean', default: false, help: 'Write to DB' },
};

describe('answersToArgv', () => {
  it('emits nothing for an undefined (skipped) answer', () => {
    expect(answersToArgv(SPECS, { unit: undefined })).toEqual([]);
  });

  it('emits nothing for a boolean answered false', () => {
    expect(answersToArgv(SPECS, { all: false })).toEqual([]);
  });

  it('emits a bare flag for a boolean answered true', () => {
    expect(answersToArgv(SPECS, { all: true })).toEqual(['--all']);
  });

  it('emits --flag value for a string answer', () => {
    expect(answersToArgv(SPECS, { unit: 'unit-3' })).toEqual(['--unit', 'unit-3']);
  });

  it('emits --flag value for a number answer, stringified', () => {
    expect(answersToArgv(SPECS, { count: 5 })).toEqual(['--count', '5']);
  });

  it('preserves flag order from the spec, independent of answer insertion order', () => {
    const answers = { 'write-db': true, unit: 'unit-2', all: false, count: 3 };
    expect(answersToArgv(SPECS, answers)).toEqual(['--unit', 'unit-2', '--count', '3', '--write-db']);
  });

  it('produces an empty argv when every answer is skipped or false', () => {
    expect(answersToArgv(SPECS, {})).toEqual([]);
  });
});

describe('formatCommandLine', () => {
  it('joins the command name and args behind the pipeline prefix', () => {
    expect(formatCommandLine('questions-generate', ['--unit', 'unit-2', '--write-db'])).toBe(
      'pipeline questions-generate --unit unit-2 --write-db',
    );
  });

  it('quotes an argument containing whitespace', () => {
    expect(formatCommandLine('content-suggest-topics', ['content/markdown/Unit 4.md', 'unit-4'])).toBe(
      'pipeline content-suggest-topics "content/markdown/Unit 4.md" unit-4',
    );
  });

  it('renders a bare command with no args', () => {
    expect(formatCommandLine('db-check-connection', [])).toBe('pipeline db-check-connection');
  });
});
