import { describe, expect, it } from 'vitest';
import { shouldEnterGuidedMode } from '../src/lib/dispatch/tty-gate';

describe('shouldEnterGuidedMode', () => {
  it('enters guided mode with no argv, both stdio streams a TTY, and not in CI', () => {
    expect(shouldEnterGuidedMode({ argv: [], isStdinTTY: true, isStdoutTTY: true, isCI: false })).toBe(true);
  });

  it('never enters guided mode when any argument is given, even at a TTY', () => {
    expect(shouldEnterGuidedMode({ argv: ['--help'], isStdinTTY: true, isStdoutTTY: true, isCI: false })).toBe(false);
    expect(
      shouldEnterGuidedMode({ argv: ['questions-generate'], isStdinTTY: true, isStdoutTTY: true, isCI: false }),
    ).toBe(false);
  });

  it('never enters guided mode in CI, even at a TTY with no argv', () => {
    expect(shouldEnterGuidedMode({ argv: [], isStdinTTY: true, isStdoutTTY: true, isCI: true })).toBe(false);
  });

  it('never enters guided mode when stdin is not a TTY (piped input)', () => {
    expect(shouldEnterGuidedMode({ argv: [], isStdinTTY: false, isStdoutTTY: true, isCI: false })).toBe(false);
  });

  it('never enters guided mode when stdout is not a TTY (piped/redirected output)', () => {
    expect(shouldEnterGuidedMode({ argv: [], isStdinTTY: true, isStdoutTTY: false, isCI: false })).toBe(false);
  });

  it('never enters guided mode when neither stream is a TTY', () => {
    expect(shouldEnterGuidedMode({ argv: [], isStdinTTY: false, isStdoutTTY: false, isCI: false })).toBe(false);
  });
});
