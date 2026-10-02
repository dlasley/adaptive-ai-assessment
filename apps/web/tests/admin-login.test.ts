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

const { isAdminLoginInTightenedModeMock, recordAdminLoginFailureMock, retryAfterMock, recordIpMissMock } = vi.hoisted(() => ({
  recordIpMissMock: vi.fn(),
  isAdminLoginInTightenedModeMock: vi.fn(),
  recordAdminLoginFailureMock: vi.fn(),
  retryAfterMock: vi.fn(),
}));

vi.mock('@/lib/admin-lockout-policy', () => ({
  isAdminLoginInTightenedMode: isAdminLoginInTightenedModeMock,
  recordAdminLoginFailure: recordAdminLoginFailureMock,
  adminLoginTightenedRetryAfterSeconds: retryAfterMock,
  adminLoginIpLockRetryAfterSeconds: async () => null,
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

function loginRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
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
  recordIpMissMock.mockReset();
  verifyAdminPasswordMock.mockReset();
  createSessionCookieMock.mockReset();
  createSessionCookieMock.mockReturnValue({ name: 'admin_session', value: 'token', options: {} });
});

describe('POST /api/admin/login', () => {
  it('records a global failure when the password is wrong', async () => {
    verifyAdminPasswordMock.mockReturnValue(false);

    const res = await POST(loginRequest({ password: 'wrong' }));

    expect(res.status).toBe(401);
    expect(recordAdminLoginFailureMock).toHaveBeenCalledTimes(1);
  });

  it('does not record a failure on a successful login', async () => {
    verifyAdminPasswordMock.mockReturnValue(true);

    const res = await POST(loginRequest({ password: 'correct' }));

    expect(res.status).toBe(200);
    expect(recordAdminLoginFailureMock).not.toHaveBeenCalled();
  });

  it('checks the global circuit breaker before verifying the password', async () => {
    verifyAdminPasswordMock.mockReturnValue(true);

    await POST(loginRequest({ password: 'correct' }));

    expect(isAdminLoginInTightenedModeMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/admin/login malformed input', () => {
  function rawRequest(body: string): NextRequest {
    return new NextRequest('https://example.com/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
      body,
    });
  }

  it.each([
    ['a numeric password', { password: 123 }],
    ['an object password', { password: { a: 1 } }],
    ['a null password', { password: null }],
    ['a missing password', {}],
    ['an oversized password', { password: 'x'.repeat(201) }],
  ])('answers 400 for %s and counts it against the IP', async (_name, body) => {
    const res = await POST(loginRequest(body));

    expect(res.status).toBe(400);
    expect(verifyAdminPasswordMock).not.toHaveBeenCalled();
    expect(recordIpMissMock).toHaveBeenCalledTimes(1);
    expect(recordAdminLoginFailureMock).not.toHaveBeenCalled();
  });

  it('answers 400 for a body that is not JSON and counts it as a failed attempt', async () => {
    const res = await POST(rawRequest('{not json'));

    expect(res.status).toBe(400);
    expect(recordIpMissMock).toHaveBeenCalledTimes(1);
    expect(recordAdminLoginFailureMock).not.toHaveBeenCalled();
  });

  it('still answers 401 and counts a failure for an empty string password', async () => {
    verifyAdminPasswordMock.mockReturnValue(false);

    const res = await POST(loginRequest({ password: '' }));

    expect(res.status).toBe(401);
    expect(recordAdminLoginFailureMock).toHaveBeenCalledTimes(1);
  });
});
