/**
 * Decides whether `pipeline` (no arguments) should enter guided mode. Guided mode only makes
 * sense at an interactive terminal: CI runners and piped/redirected input have neither stdin nor
 * stdout attached to a TTY, and prompting there would hang forever waiting for input nobody can
 * provide. A non-empty argv always means a direct command or subcommand — guided mode is never
 * entered once the user has told `pipeline` what to do.
 */

export interface TtyGateInput {
  argv: string[];
  isStdinTTY: boolean;
  isStdoutTTY: boolean;
  isCI: boolean;
}

export function shouldEnterGuidedMode(input: TtyGateInput): boolean {
  if (input.argv.length > 0) return false;
  if (input.isCI) return false;
  return input.isStdinTTY && input.isStdoutTTY;
}
