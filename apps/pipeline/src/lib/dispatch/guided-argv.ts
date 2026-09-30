/**
 * Pure construction of a command's argv from guided mode's collected answers, kept separate from
 * the interactive prompting (`guided.ts`) so the mapping from answers to flags is testable without
 * a TTY.
 */

import type { OptionSpecs } from '../options/types';

/** One flag's answer from guided mode. `undefined` means "skipped" (optional field, left at its
 * script-side default) and emits no flag at all. */
export type GuidedAnswers = Record<string, string | number | boolean | undefined>;

/**
 * Builds the argv a direct invocation of the command would need to reproduce guided mode's
 * answers. Boolean `true` emits a bare `--flag`; `false` and `undefined` emit nothing (the
 * script's own default applies). Every other answer emits `--flag value`.
 */
export function answersToArgv(specs: OptionSpecs, answers: GuidedAnswers): string[] {
  const args: string[] = [];
  for (const flagName of Object.keys(specs)) {
    const value = answers[flagName];
    if (value === undefined || value === false) continue;
    if (value === true) {
      args.push(`--${flagName}`);
      continue;
    }
    args.push(`--${flagName}`, String(value));
  }
  return args;
}

/** Renders argv back into the exact command line guided mode shows before asking to confirm. */
export function formatCommandLine(commandName: string, args: string[]): string {
  const quoted = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg));
  return ['pipeline', commandName, ...quoted].join(' ');
}
