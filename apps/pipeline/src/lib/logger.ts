/**
 * Structured logger for pipeline scripts. Every line is tagged with a level and a component name
 * (typically the file that created it) so `npx tsx` output stays greppable across the ~20 scripts
 * that share it, without turning routine CLI runs into a JSON-log stream.
 *
 * The minimum level is process-global, set once via `setLogLevel()` near the top of a script's
 * entry point from its `--verbose`/`--quiet` flags (see `levelFromFlags`), rather than threaded
 * through every function call. A single `npx tsx script.ts` invocation is one process, so there is
 * no cross-run state to worry about.
 *
 * This is for internal tracing and diagnostics, not the output a script's own CLI contract
 * promises its user — `--help` text, final summaries, and progress lines meant to be read
 * interactively stay as plain `console.log`/`console.table` at their call sites.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const CONSOLE_METHOD: Record<LogLevel, 'log' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

let currentLevel: LogLevel = 'info';

/** Sets the minimum level for every logger created via `createLogger`, for the rest of this process. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Resolves a script's parsed `--verbose`/`--quiet` flags to a level. `--verbose` wins if both are set. */
export function levelFromFlags(flags: { verbose?: boolean; quiet?: boolean }): LogLevel {
  if (flags.verbose) return 'debug';
  if (flags.quiet) return 'warn';
  return 'info';
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function emit(component: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;

  const line = `[${level.toUpperCase()}] [${component}] ${message}`;
  if (data === undefined) {
    console[CONSOLE_METHOD[level]](line);
  } else {
    console[CONSOLE_METHOD[level]](line, data);
  }
}

/** Creates a logger tagged with a component name (typically the script or module file name). */
export function createLogger(component: string): Logger {
  return {
    debug: (message, data) => emit(component, 'debug', message, data),
    info: (message, data) => emit(component, 'info', message, data),
    warn: (message, data) => emit(component, 'warn', message, data),
    error: (message, data) => emit(component, 'error', message, data),
  };
}
