import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const from = vi.fn();
const single = vi.fn();
const checkRateLimit = vi.fn();
const getRateLimitStore = vi.fn();
const isCodeLockedOut = vi.fn();
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
}));

vi.mock('@/lib/verify-code-guard', () => ({
  isCodeLockedOut: (...args: unknown[]) => isCodeLockedOut(...args),
  isInTightenedMode: (...args: unknown[]) => isInTightenedMode(...args),
  recordCodeLookupFailure: (...args: unknown[]) => recordCodeLookupFailure(...args),
  recordGlobalLookupFailure: (...args: unknown[]) => recordGlobalLookupFailure(...args),
  TIGHTENED_MODE_DELAY_MS: 0,
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
  isCodeLockedOut.mockReset();
  isInTightenedMode.mockReset();
  recordCodeLookupFailure.mockReset();
  recordGlobalLookupFailure.mockReset();
  isTurnstileConfigured.mockReset();
  verifyTurnstileToken.mockReset();

  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 });
  getRateLimitStore.mockReturnValue({});
  isCodeLockedOut.mockResolvedValue(false);
  verifyTurnstileToken.mockResolvedValue({ success: false, reason: 'missing_token' });
  single.mockResolvedValue({ data: VALID_STUDY_CODE_ROW, error: null });
  from.mockReturnValue({
    select: () => ({
      eq: () => ({ single }),
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

  it('falls back to the fixed delay when Turnstile is not configured', async () => {
    isInTightenedMode.mockResolvedValue(true);
    isTurnstileConfigured.mockReturnValue(false);

    const response = await POST(makeRequest({ code: 'happy elephant' }));
    const body = await response.json();

    expect(verifyTurnstileToken).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body.exists).toBe(true);
  });
});
