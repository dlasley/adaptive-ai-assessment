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

const { isAdminLoginInTightenedModeMock, recordAdminLoginFailureMock } = vi.hoisted(() => ({
  isAdminLoginInTightenedModeMock: vi.fn(),
  recordAdminLoginFailureMock: vi.fn(),
}));

// Delay set to 0 so a tripped circuit breaker doesn't slow this test down — the wiring is what's
// under test, not the wall-clock delay itself.
vi.mock('@/lib/admin-lockout-policy', () => ({
  isAdminLoginInTightenedMode: isAdminLoginInTightenedModeMock,
  recordAdminLoginFailure: recordAdminLoginFailureMock,
  ADMIN_LOGIN_TIGHTENED_MODE_DELAY_MS: 0,
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
  recordAdminLoginFailureMock.mockReset();
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
