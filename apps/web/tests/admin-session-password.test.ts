import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { verifyAdminPassword } from '@/lib/admin-session';

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
