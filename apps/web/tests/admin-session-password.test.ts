import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { ADMIN_PASSWORD_MIN_LENGTH, verifyAdminPassword } from '@/lib/admin-session';

describe('verifyAdminPassword', () => {
  const original = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  });

  it('accepts the configured password and rejects others', () => {
    expect(verifyAdminPassword('correct horse battery staple')).toBe(true);
    expect(verifyAdminPassword('correct horse battery stapl3')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
  });

  it('rejects everything when no password is configured', () => {
    delete process.env.ADMIN_PASSWORD;

    expect(verifyAdminPassword('')).toBe(false);
    expect(verifyAdminPassword('anything')).toBe(false);
  });

  it('runs the same constant-time comparison whatever the length of the guess', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');

    verifyAdminPassword('short');
    verifyAdminPassword('x'.repeat(150));

    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});

describe('verifyAdminPassword minimum length', () => {
  const original = process.env.ADMIN_PASSWORD;

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = original;
  });

  it('refuses to verify a configured password shorter than 16 characters, even when the guess matches', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ADMIN_PASSWORD = 'a'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1);

    expect(verifyAdminPassword('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH - 1))).toBe(false);
  });

  it('accepts a password of exactly 16 characters', () => {
    process.env.ADMIN_PASSWORD = 'a'.repeat(ADMIN_PASSWORD_MIN_LENGTH);
    expect(verifyAdminPassword('a'.repeat(ADMIN_PASSWORD_MIN_LENGTH))).toBe(true);
  });

  it('logs the refusal once, never the password', async () => {
    vi.resetModules();
    const { verifyAdminPassword: freshVerify } = await import('@/lib/admin-session');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ADMIN_PASSWORD = 'tiny';

    freshVerify('tiny');
    freshVerify('tiny');

    const refusals = errorSpy.mock.calls.filter(([line]) => String(line).includes('ADMIN_PASSWORD'));
    expect(refusals).toHaveLength(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('tiny');
  });
});
