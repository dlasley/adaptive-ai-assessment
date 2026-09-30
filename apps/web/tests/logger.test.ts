import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.VERCEL_ENV;
  vi.restoreAllMocks();
});

describe('createLogger level gating', () => {
  it('emits debug in development (no VERCEL_ENV, NODE_ENV=development)', () => {
    delete process.env.VERCEL_ENV;
    vi.stubEnv('NODE_ENV', 'development');

    createLogger('test').debug('hello');

    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('emits debug in test (no VERCEL_ENV, NODE_ENV=test)', () => {
    delete process.env.VERCEL_ENV;
    vi.stubEnv('NODE_ENV', 'test');

    createLogger('test').debug('hello');

    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it('silences debug when NODE_ENV=production and VERCEL_ENV is unset', () => {
    delete process.env.VERCEL_ENV;
    vi.stubEnv('NODE_ENV', 'production');

    createLogger('test').debug('hello');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('silences debug on Vercel production', () => {
    process.env.VERCEL_ENV = 'production';
    vi.stubEnv('NODE_ENV', 'production');

    createLogger('test').debug('hello');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('silences debug on a Vercel preview deploy, which shares the production database', () => {
    process.env.VERCEL_ENV = 'preview';
    vi.stubEnv('NODE_ENV', 'production');

    createLogger('test').debug('hello');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('silences debug for any non-empty VERCEL_ENV, including "development" (vercel dev)', () => {
    process.env.VERCEL_ENV = 'development';
    vi.stubEnv('NODE_ENV', 'development');

    createLogger('test').debug('hello');

    expect(console.log).not.toHaveBeenCalled();
  });

  it('always emits info/warn/error, in development and in production alike', () => {
    process.env.VERCEL_ENV = 'production';

    const logger = createLogger('test');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('tags every line with the component name and level', () => {
    process.env.VERCEL_ENV = 'development';

    createLogger('my-component').warn('something happened');

    expect(console.warn).toHaveBeenCalledWith('[WARN] [my-component] something happened');
  });

  it('appends a data object as a second argument when provided', () => {
    process.env.VERCEL_ENV = 'development';

    createLogger('my-component').info('tier used', { tier: 'exact_match' });

    expect(console.log).toHaveBeenCalledWith(
      '[INFO] [my-component] tier used',
      { tier: 'exact_match' }
    );
  });
});
