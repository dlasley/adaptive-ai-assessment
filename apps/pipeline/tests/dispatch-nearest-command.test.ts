import { describe, expect, it } from 'vitest';
import { nearestCommand } from '../src/lib/dispatch/nearest-command';

const NAMES = ['questions-generate', 'questions-plan', 'questions-audit', 'audit-compare', 'pipeline-run'];

describe('nearestCommand', () => {
  it('suggests the closest name for a one-character typo', () => {
    expect(nearestCommand('questons-generate', NAMES)).toBe('questions-generate');
  });

  it('suggests the closest name for a transposition', () => {
    expect(nearestCommand('pipelin-run', NAMES)).toBe('pipeline-run');
  });

  it('returns null for an unrelated word', () => {
    expect(nearestCommand('banana', NAMES)).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(nearestCommand('anything', [])).toBeNull();
  });
});
