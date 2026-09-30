import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger, levelFromFlags, setLogLevel } from '../src/lib/logger';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setLogLevel('info');
  vi.restoreAllMocks();
});

describe('levelFromFlags', () => {
  it('defaults to info when neither flag is set', () => {
    expect(levelFromFlags({})).toBe('info');
  });

  it('resolves --verbose to debug', () => {
    expect(levelFromFlags({ verbose: true })).toBe('debug');
  });

  it('resolves --quiet to warn', () => {
    expect(levelFromFlags({ quiet: true })).toBe('warn');
  });

  it('prefers --verbose when both are set', () => {
    expect(levelFromFlags({ verbose: true, quiet: true })).toBe('debug');
  });
});

describe('createLogger level gating', () => {
  it('suppresses debug at the default (info) level', () => {
    setLogLevel('info');

    createLogger('test').debug('hello');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('emits debug once the level is set to debug', () => {
    setLogLevel('debug');

    createLogger('test').debug('hello');

    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('suppresses info at the warn (--quiet) level, but keeps warn and error', () => {
    setLogLevel('warn');

    const logger = createLogger('test');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('always emits info at the default level', () => {
    setLogLevel('info');

    createLogger('test').info('hello');

    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('tags every line with the level and component name', () => {
    setLogLevel('debug');

    createLogger('my-script').warn('something happened');

    expect(console.warn).toHaveBeenCalledWith('[WARN] [my-script] something happened');
  });

  it('appends a data object as a second argument when provided', () => {
    setLogLevel('debug');

    createLogger('my-script').info('batch complete', { count: 5 });

    expect(console.log).toHaveBeenCalledWith('[INFO] [my-script] batch complete', { count: 5 });
  });
});
