import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const from = vi.fn();
const single = vi.fn();
const checkRateLimit = vi.fn();
const getRateLimitStore = vi.fn();
const codeLockRetryAfterSeconds = vi.fn();
const ipLockRetryAfterSeconds = vi.fn();
const recordIpMiss = vi.fn();
const tightenedModeRetryAfterSeconds = vi.fn();
const eq = vi.fn();
const isInTightenedMode = vi.fn();
const recordCodeLookupFailure = vi.fn();
const recordGlobalLookupFailure = vi.fn();
const isTurnstileConfigured = vi.fn();
const verifyTurnstileToken = vi.fn();

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
  getClientIp: () => '203.0.113.7',
  getRateLimitStore: (...args: unknown[]) => getRateLimitStore(...args),
}));

vi.mock('@/lib/csrf', () => ({
  verifyCsrfProtection: () => null,
}));

vi.mock('@/lib/student-session', () => ({
  createStudentSessionCookie: () => ({
    name: 'student_session',
    value: 'signed-cookie-value',
    options: { httpOnly: true, path: '/' },
  }),
  createStudentSessionToken: () => 'signed-token-value',
}));

vi.mock('@/lib/verify-code-guard', () => ({
  codeLockRetryAfterSeconds: (...args: unknown[]) => codeLockRetryAfterSeconds(...args),
  ipLockRetryAfterSeconds: (...args: unknown[]) => ipLockRetryAfterSeconds(...args),
  recordIpMiss: (...args: unknown[]) => recordIpMiss(...args),
  tightenedModeRetryAfterSeconds: (...args: unknown[]) => tightenedModeRetryAfterSeconds(...args),
  isInTightenedMode: (...args: unknown[]) => isInTightenedMode(...args),
  recordCodeLookupFailure: (...args: unknown[]) => recordCodeLookupFailure(...args),
  recordGlobalLookupFailure: (...args: unknown[]) => recordGlobalLookupFailure(...args),
}));

vi.mock('@/lib/turnstile', () => ({
  isTurnstileConfigured: (...args: unknown[]) => isTurnstileConfigured(...args),
  verifyTurnstileToken: (...args: unknown[]) => verifyTurnstileToken(...args),
}));

const { POST } = await import('@/app/api/verify-code/route');

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://french-1.vercel.app/api/verify-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_STUDY_CODE_ROW = {
  id: 'study-code-id',
  code: 'happy elephant',
  display_name: null,
  created_at: '2026-01-01T00:00:00.000Z',
  total_quizzes: 0,
  total_questions: 0,
  correct_answers: 0,
  session_epoch: 1,
};

beforeEach(() => {
  from.mockReset();
  single.mockReset();
  checkRateLimit.mockReset();
  getRateLimitStore.mockReset();
  codeLockRetryAfterSeconds.mockReset();
  ipLockRetryAfterSeconds.mockReset();
  recordIpMiss.mockReset();
  tightenedModeRetryAfterSeconds.mockReset();
  eq.mockReset();
  isInTightenedMode.mockReset();
  recordCodeLookupFailure.mockReset();
  recordGlobalLookupFailure.mockReset();
  isTurnstileConfigured.mockReset();
  verifyTurnstileToken.mockReset();

  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 });
  getRateLimitStore.mockReturnValue({});
  codeLockRetryAfterSeconds.mockResolvedValue(null);
  ipLockRetryAfterSeconds.mockResolvedValue(null);
  tightenedModeRetryAfterSeconds.mockResolvedValue(240);
  eq.mockReturnValue({ single });
  verifyTurnstileToken.mockResolvedValue({ success: false, reason: 'missing_token' });
  single.mockResolvedValue({ data: VALID_STUDY_CODE_ROW, error: null });
  from.mockReturnValue({
    select: () => ({
      eq: (...args: unknown[]) => eq(...args),
    }),
  });
});

describe('POST /api/verify-code with Turnstile in tightened mode', () => {
  it('rejects non-string code or turnstileToken with 400 before any lookup', async () => {
    for (const body of [{ code: 42 }, { code: ['happy elephant'] }, { code: 'happy elephant', turnstileToken: { t: 1 } }]) {
      const response = await POST(makeRequest(body));
      expect(response.status).toBe(400);
    }
    expect(verifyTurnstileToken).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('returns 403 with turnstileRequired and the site key when no token is provided', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'test-site-key';

    const response = await POST(makeRequest({ code: 'happy elephant' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.turnstileRequired).toBe(true);
    expect(body.turnstileSiteKey).toBe('test-site-key');
    expect(verifyTurnstileToken).toHaveBeenCalledWith(undefined, '203.0.113.7');
    expect(from).not.toHaveBeenCalled();
  });

  it('carries the rest of the failure window as a whole-second Retry-After on the 403', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);

    const response = await POST(makeRequest({ code: 'happy elephant' }));
    const retryAfter = response.headers.get('Retry-After');

    expect(response.status).toBe(403);
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBe(240);
    expect(tightenedModeRetryAfterSeconds).toHaveBeenCalledTimes(1);
  });

  it('sends no Retry-After when a supplied token failed, since a fresh token is the remedy', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    verifyTurnstileToken.mockResolvedValue({ success: false, reason: 'invalid_token' });

    const response = await POST(makeRequest({ code: 'happy elephant', turnstileToken: 'stale' }));

    expect(response.status).toBe(403);
    expect((await response.json()).turnstileRequired).toBe(true);
    expect(response.headers.get('Retry-After')).toBeNull();
    expect(tightenedModeRetryAfterSeconds).not.toHaveBeenCalled();
  });

  it('proceeds to the database lookup once a valid token is supplied', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    verifyTurnstileToken.mockResolvedValue({ success: true });

    const response = await POST(makeRequest({ code: 'happy elephant', turnstileToken: 'solved-token' }));
    const body = await response.json();

    expect(verifyTurnstileToken).toHaveBeenCalledWith('solved-token', '203.0.113.7');
    expect(response.status).toBe(200);
    expect(body.exists).toBe(true);
  });

  it('returns 403 again when the supplied token fails verification', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    verifyTurnstileToken.mockResolvedValue({ success: false, reason: 'challenge_failed' });

    const response = await POST(makeRequest({ code: 'happy elephant', turnstileToken: 'bad-token' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.turnstileRequired).toBe(true);
    expect(from).not.toHaveBeenCalled();
  });

  it('skips Turnstile entirely outside tightened mode', async () => {
    isInTightenedMode.mockResolvedValue(false);
    isTurnstileConfigured.mockReturnValue(true);

    const response = await POST(makeRequest({ code: 'happy elephant' }));
    const body = await response.json();

    expect(verifyTurnstileToken).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body.exists).toBe(true);
  });

  it('answers 429 with the rest of the window as Retry-After when Turnstile is not configured', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(false);

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('240');
    expect(verifyTurnstileToken).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
});

describe('POST /api/verify-code database errors', () => {
  it('answers 503 for a database error and counts nothing against the code or the site', async () => {
    single.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(503);
    expect(recordCodeLookupFailure).not.toHaveBeenCalled();
    expect(recordGlobalLookupFailure).not.toHaveBeenCalled();
  });

  it('answers exists:false and counts a failure when the code is not found', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exists: false });
    expect(recordCodeLookupFailure).toHaveBeenCalledTimes(1);
    expect(recordGlobalLookupFailure).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/verify-code per-IP miss lock', () => {
  it('answers 429 with Retry-After while the IP is locked, before any lookup', async () => {
    ipLockRetryAfterSeconds.mockResolvedValue(600);

    const response = await POST(makeRequest({ code: 'brave purple penguin' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('600');
    expect(from).not.toHaveBeenCalled();
  });

  it('counts a not-found code against the IP, and a found code does not', async () => {
    await POST(makeRequest({ code: 'happy elephant' }));
    expect(recordIpMiss).not.toHaveBeenCalled();

    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    await POST(makeRequest({ code: 'unknown code' }));
    expect(recordIpMiss).toHaveBeenCalledWith(expect.anything(), '203.0.113.7');
  });

  it('answers 429 with Retry-After for a locked code string', async () => {
    codeLockRetryAfterSeconds.mockResolvedValue(300);

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('300');
  });
});

describe('POST /api/verify-code code formats', () => {
  it.each(['happy elephant', 'brave purple penguin'])('looks up %s as the stored, normalized string', async (code) => {
    const response = await POST(makeRequest({ code: `  ${code.toUpperCase()} ` }));

    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('code', code);
  });
});

describe('POST /api/verify-code in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses every request with 503 when Turnstile is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    isTurnstileConfigured.mockReturnValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(503);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('serves requests when Turnstile is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    isTurnstileConfigured.mockReturnValue(true);

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(200);
  });

  it('treats a Vercel production deployment the same way', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    isTurnstileConfigured.mockReturnValue(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(makeRequest({ code: 'happy elephant' }));

    expect(response.status).toBe(503);
  });
});

describe('POST /api/verify-code session delivery by platform', () => {
  it('answers a native caller with the token in the body and no cookie', async () => {
    const response = await POST(makeRequest({ code: 'happy elephant', platform: 'native' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Object.keys(body).sort()).toEqual(['details', 'exists', 'token']);
    expect(body.exists).toBe(true);
    expect(body.token).toBe('signed-token-value');
    expect(body.details).not.toHaveProperty('session_epoch');
  });

  it.each([
    ['absent', {}],
    ['web', { platform: 'web' }],
  ])('sets the cookie and returns no token with platform %s', async (_name, extra) => {
    const response = await POST(makeRequest({ code: 'happy elephant', ...extra }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('student_session=signed-cookie-value');
    expect(Object.keys(body).sort()).toEqual(['details', 'exists']);
  });

  it('rejects an unknown platform with 400 before any lookup', async () => {
    const response = await POST(makeRequest({ code: 'happy elephant', platform: 'ios' }));

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });

  it('returns no token and no cookie to a native caller whose code is not found', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const response = await POST(makeRequest({ code: 'unknown code', platform: 'native' }));

    expect(await response.json()).toEqual({ exists: false });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /api/verify-code platform is never a control', () => {
  it('still answers 403 turnstileRequired to a native caller with no token in tightened mode', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await POST(makeRequest({ code: 'happy elephant', platform: 'native' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.turnstileRequired).toBe(true);
    expect(body).not.toHaveProperty('token');
    expect(from).not.toHaveBeenCalled();
  });

  it('still answers 429 to a native caller in tightened mode when Turnstile is not configured', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(false);

    const response = await POST(makeRequest({ code: 'happy elephant', platform: 'native' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).not.toHaveProperty('token');
    expect(from).not.toHaveBeenCalled();
  });

  it('logs the platform on a failed Turnstile verification', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warn.mockClear();

    await POST(makeRequest({ code: 'happy elephant', platform: 'native' }));
    await POST(makeRequest({ code: 'happy elephant' }));

    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('Turnstile verification failed'), {
      reason: 'missing_token',
      platform: 'native',
    });
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('Turnstile verification failed'), {
      reason: 'missing_token',
      platform: 'web',
    });
  });

  it('records all three failure counters for a native not-found lookup', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    await POST(makeRequest({ code: 'unknown code', platform: 'native' }));

    expect(recordCodeLookupFailure).toHaveBeenCalledWith(expect.anything(), 'unknown code');
    expect(recordGlobalLookupFailure).toHaveBeenCalledTimes(1);
    expect(recordIpMiss).toHaveBeenCalledWith(expect.anything(), '203.0.113.7');
  });

  it('keys every rate limit and lock the same way for a native caller as for the web', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    const keyedCalls = () =>
      [checkRateLimit, ipLockRetryAfterSeconds, codeLockRetryAfterSeconds, recordCodeLookupFailure, recordIpMiss].map(
        (mock) => mock.mock.calls.map((call) => call.filter((arg) => typeof arg === 'string')),
      );

    await POST(makeRequest({ code: 'unknown code' }));
    const web = keyedCalls();
    for (const mock of [checkRateLimit, ipLockRetryAfterSeconds, codeLockRetryAfterSeconds, recordCodeLookupFailure, recordIpMiss]) {
      mock.mockClear();
    }
    await POST(makeRequest({ code: 'unknown code', platform: 'native' }));

    expect(keyedCalls()).toEqual(web);
    expect(web[0]).toEqual([['verify-code:203.0.113.7']]);
  });
});
