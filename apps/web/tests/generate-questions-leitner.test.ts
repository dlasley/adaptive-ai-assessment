import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { eqMock, fromMock, liveEpochMock } = vi.hoisted(() => {
  const eqMock = vi.fn().mockResolvedValue({ data: [], error: null });
  const liveEpochMock = vi.fn().mockResolvedValue({ data: { session_epoch: 1 }, error: null });
  // study_codes answers the session guard's epoch lookup; every other table is the Leitner read.
  const fromMock = vi.fn((table: string) =>
    table === 'study_codes'
      ? { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: liveEpochMock })) })) }
      : { select: vi.fn(() => ({ eq: eqMock })) }
  );
  return { eqMock, fromMock, liveEpochMock };
});

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: () => '203.0.113.9',
}));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

const { requireStudentSessionMock } = vi.hoisted(() => ({
  requireStudentSessionMock: vi.fn(),
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: requireStudentSessionMock,
}));

vi.mock('@/lib/feature-flags', () => ({
  FEATURES: { LEITNER_MODE: true },
}));

vi.mock('@/lib/question-loader', () => ({
  loadAllQuestions: vi.fn().mockResolvedValue([
    {
      id: 'q1',
      unitId: 'unit-1',
      type: 'multiple-choice',
      question: 'Q?',
      correctAnswer: 'A',
      difficulty: 'beginner',
      topic: 'greetings',
    },
  ]),
  selectQuestions: vi.fn((questions) => ({
    questions,
    warnings: [],
    requestedCount: 1,
    actualCount: questions.length,
  })),
}));

import { POST } from '@/app/api/generate-questions/route';
import { createStudentSessionToken, getStudentCookieName } from '@/lib/student-session';

const { requireStudentSession: realRequireStudentSession } =
  await vi.importActual<typeof import('@/lib/student-api-guard')>('@/lib/student-api-guard');

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/generate-questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
  eqMock.mockClear();
  fromMock.mockClear();
  liveEpochMock.mockClear();
  requireStudentSessionMock.mockReset();
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });
});

describe('POST /api/generate-questions Leitner weighting', () => {
  it('scopes the Leitner read to the session studyCodeId, ignoring a body-supplied one', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });

    const res = await POST(
      makeRequest({
        unitId: 'all',
        numQuestions: 1,
        difficulty: 'beginner',
        leitnerMode: true,
        studyCodeId: 'attacker-study-id',
      })
    );

    expect(res.status).toBe(200);
    expect(eqMock).toHaveBeenCalledWith('study_code_id', 'session-study-id');
    expect(eqMock).not.toHaveBeenCalledWith('study_code_id', 'attacker-study-id');
  });

  it('skips Leitner weighting entirely (no DB call) when there is no valid session', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await POST(
      makeRequest({
        unitId: 'all',
        numQuestions: 1,
        difficulty: 'beginner',
        leitnerMode: true,
      })
    );

    expect(res.status).toBe(200);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/generate-questions Leitner weighting with a bearer token', () => {
  const LEITNER_BODY = { unitId: 'all', numQuestions: 1, difficulty: 'beginner', leitnerMode: true };

  beforeEach(() => {
    requireStudentSessionMock.mockImplementation(realRequireStudentSession);
  });

  it("reads leitner_state for the bearer's studyCodeId", async () => {
    const res = await POST(
      makeRequest(LEITNER_BODY, { authorization: `Bearer ${createStudentSessionToken('bearer-study-id', 1)}` })
    );

    expect(res.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith('leitner_state');
    expect(eqMock).toHaveBeenCalledWith('study_code_id', 'bearer-study-id');
  });

  it("ignores a valid cookie behind a garbage bearer: no Leitner read, anonymous rate key", async () => {
    const res = await POST(
      makeRequest(LEITNER_BODY, {
        authorization: 'Bearer garbage',
        cookie: `${getStudentCookieName()}=${createStudentSessionToken('cookie-study-id', 1)}`,
      })
    );

    expect(res.status).toBe(200);
    expect(fromMock).not.toHaveBeenCalledWith('leitner_state');
    expect(eqMock).not.toHaveBeenCalled();
    const keys = checkRateLimitMock.mock.calls.map(([key]) => key);
    expect(keys).toContain('generate-questions:anon:203.0.113.9');
    expect(keys).not.toContain('generate-questions:session:cookie-study-id');
  });
});
