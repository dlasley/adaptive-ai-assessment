import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { checkRateLimitMock, getRateLimitStoreMock } = vi.hoisted(() => ({
  checkRateLimitMock: vi.fn(),
  getRateLimitStoreMock: vi.fn(),
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: () => '127.0.0.1',
  getRateLimitStore: getRateLimitStoreMock,
}));

const {
  isAdminLoginInTightenedModeMock,
  recordAdminLoginFailureMock,
  retryAfterMock,
  ipLockMock,
  recordIpMissMock,
} = vi.hoisted(() => ({
  isAdminLoginInTightenedModeMock: vi.fn(),
  recordAdminLoginFailureMock: vi.fn(),
  retryAfterMock: vi.fn(),
  ipLockMock: vi.fn(),
  recordIpMissMock: vi.fn(),
}));

vi.mock('@/lib/admin-lockout-policy', () => ({
  isAdminLoginInTightenedMode: isAdminLoginInTightenedModeMock,
  recordAdminLoginFailure: recordAdminLoginFailureMock,
  adminLoginTightenedRetryAfterSeconds: retryAfterMock,
  adminLoginIpLockRetryAfterSeconds: ipLockMock,
  recordAdminLoginIpMiss: recordIpMissMock,
}));

const { verifyAdminPasswordMock, createSessionCookieMock } = vi.hoisted(() => ({
  verifyAdminPasswordMock: vi.fn(),
  createSessionCookieMock: vi.fn(),
}));

vi.mock('@/lib/admin-session', () => ({
  verifyAdminPassword: verifyAdminPasswordMock,
  createSessionCookie: createSessionCookieMock,
}));

import { POST } from '@/app/api/admin/login/route';

const PROD_URL = 'french-1.vercel.app';

function loginRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 1000 });
  getRateLimitStoreMock.mockReset();
  getRateLimitStoreMock.mockReturnValue({});
  isAdminLoginInTightenedModeMock.mockReset();
  isAdminLoginInTightenedModeMock.mockResolvedValue(false);
  retryAfterMock.mockResolvedValue(180);
  recordAdminLoginFailureMock.mockReset();
  ipLockMock.mockReset();
  ipLockMock.mockResolvedValue(null);
  recordIpMissMock.mockReset();
  verifyAdminPasswordMock.mockReset();
  createSessionCookieMock.mockReset();
  createSessionCookieMock.mockReturnValue({ name: 'admin_session', value: 'token', options: {} });
});

describe('POST /api/admin/login CSRF', () => {
  it('rejects a cross-origin request before checking the rate limit or password', async () => {
    const res = await POST(loginRequest({ password: 'correct' }, { origin: 'https://evil.com' }));

    expect(res.status).toBe(403);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
    expect(verifyAdminPasswordMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/login per-IP rate limit', () => {
  it('returns 429 with Retry-After once the per-IP limit is exceeded, without checking the password', async () => {
    const resetAt = Date.now() + 30_000;
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt });

    const res = await POST(loginRequest({ password: 'correct' }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(body.error).toMatch(/too many/i);
    expect(verifyAdminPasswordMock).not.toHaveBeenCalled();
    expect(isAdminLoginInTightenedModeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/login global circuit breaker interplay', () => {
  it('answers 429 with Retry-After for the rest of the window once the global circuit breaker is tripped, without checking the password', async () => {
    isAdminLoginInTightenedModeMock.mockResolvedValue(true);
    verifyAdminPasswordMock.mockReturnValue(true);

    const res = await POST(loginRequest({ password: 'correct' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('180');
    expect(verifyAdminPasswordMock).not.toHaveBeenCalled();
  });

  it('still enforces the per-IP rate limit ahead of the global circuit breaker check', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000 });

    await POST(loginRequest({ password: 'correct' }));

    expect(isAdminLoginInTightenedModeMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/login per-IP miss lock', () => {
  it('answers 429 with the lock wait, ahead of the global breaker and the password check', async () => {
    ipLockMock.mockResolvedValue(240);
    verifyAdminPasswordMock.mockReturnValue(true);

    const res = await POST(loginRequest({ password: 'correct' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('240');
    expect(isAdminLoginInTightenedModeMock).not.toHaveBeenCalled();
    expect(verifyAdminPasswordMock).not.toHaveBeenCalled();
  });

  it('counts a wrong password toward the IP and the global breaker', async () => {
    verifyAdminPasswordMock.mockReturnValue(false);

    const res = await POST(loginRequest({ password: 'wrong' }));

    expect(res.status).toBe(401);
    expect(recordIpMissMock).toHaveBeenCalledWith(expect.anything(), '127.0.0.1');
    expect(recordAdminLoginFailureMock).toHaveBeenCalledTimes(1);
  });

  it('counts a malformed body toward the IP only', async () => {
    const res = await POST(loginRequest({ nope: true }));

    expect(res.status).toBe(400);
    expect(recordIpMissMock).toHaveBeenCalledTimes(1);
    expect(recordAdminLoginFailureMock).not.toHaveBeenCalled();
  });

  it('does not count a successful login', async () => {
    verifyAdminPasswordMock.mockReturnValue(true);

    const res = await POST(loginRequest({ password: 'correct' }));

    expect(res.status).toBe(200);
    expect(recordIpMissMock).not.toHaveBeenCalled();
  });
});
