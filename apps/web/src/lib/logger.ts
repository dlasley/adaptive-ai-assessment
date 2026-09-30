/**
 * Structured server-side logger. Every line is tagged with a component name so pipeline and route
 * output stays greppable, and `debug`-level calls are silenced on any deployed build so per-request
 * tracing (which is where free-text request data tends to end up) never reaches a deployed log
 * aggregator.
 *
 * `VERCEL_ENV` is set (to `production`, `preview`, or `development`) on every Vercel-built process,
 * including preview deploys — which share the production database on this project, so a preview
 * build is not a safe place for debug-level tracing either. Debug is enabled only when `VERCEL_ENV`
 * is entirely unset (a local `next dev`/`vitest` process) and `NODE_ENV !== 'production'`.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const CONSOLE_METHOD: Record<LogLevel, 'log' | 'warn' | 'error'> = {
  debug: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
};

function isProductionEnv(): boolean {
  if (process.env.VERCEL_ENV) return true;
  return process.env.NODE_ENV === 'production';
}

function minLevel(): LogLevel {
  return isProductionEnv() ? 'info' : 'debug';
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function emit(component: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;

  const line = `[${level.toUpperCase()}] [${component}] ${message}`;
  if (data === undefined) {
    console[CONSOLE_METHOD[level]](line);
  } else {
    console[CONSOLE_METHOD[level]](line, data);
  }
}

/** Creates a logger tagged with a component name (typically a route path or module name). */
export function createLogger(component: string): Logger {
  return {
    debug: (message, data) => emit(component, 'debug', message, data),
    info: (message, data) => emit(component, 'info', message, data),
    warn: (message, data) => emit(component, 'warn', message, data),
    error: (message, data) => emit(component, 'error', message, data),
  };
}
