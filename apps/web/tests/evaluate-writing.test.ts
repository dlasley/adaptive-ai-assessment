import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { singleMock, fromMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const fromMock = vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: singleMock })) })) }));
  return { singleMock, fromMock };
});

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

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const DB_QUESTION = {
  id: QUESTION_ID,
  question: 'Translate: hello',
  correctAnswer: 'Bonjour',
  difficulty: 'beginner',
  type: 'writing',
  writingType: 'translation',
  acceptableVariations: [],
  unitId: 'unit-1',
  topic: 'greetings',
};

const { loadQuestionsByIdsMock } = vi.hoisted(() => ({
  loadQuestionsByIdsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: loadQuestionsByIdsMock,
}));

// Only the "ignores a client-supplied correctAnswer" test below reaches Tier 4 (a genuine
// mismatch, not caught by exact-match or fuzzy logic); mocked here so that test never issues a
// real network call.
const { callLlmMock } = vi.hoisted(() => ({ callLlmMock: vi.fn() }));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

import { POST } from '@/app/api/evaluate-writing/route';

const PROD_URL = 'french-1.vercel.app';
const HEADERS = { 'content-type': 'application/json', origin: `https://${PROD_URL}` };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/evaluate-writing', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

/** Convenience wrapper: every test below grades the same stored question, referenced by id. */
function evaluationRequest(overrides: Record<string, unknown> = {}): NextRequest {
  return makeRequest({ questionId: QUESTION_ID, userAnswer: 'Bonjour', ...overrides });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  fromMock.mockClear();
  requireStudentSessionMock.mockReset();
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(new Map([[QUESTION_ID, DB_QUESTION]]));
  callLlmMock.mockReset();
  callLlmMock.mockResolvedValue({
    text: JSON.stringify({
      isCorrect: false,
      score: 20,
      hasCorrectAccents: false,
      feedback: 'no',
      corrections: {},
      confidenceScore: 10,
    }),
  });
});

describe('POST /api/evaluate-writing', () => {
  it('rejects with 401 when there is no session, regardless of a superuserOverride body field', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await POST(evaluationRequest({ superuserOverride: true }));

    expect(res.status).toBe(401);
  });

  it('does not include metadata for a non-superuser session even when the body claims superuserOverride: true', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
    singleMock.mockResolvedValue({ data: { is_superuser: false }, error: null });

    const res = await POST(evaluationRequest({ superuserOverride: true }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata).toBeUndefined();
  });

  it('resolves is_superuser from the session studyCodeId, not any client-supplied field', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
    singleMock.mockResolvedValue({ data: { is_superuser: true }, error: null });

    const res = await POST(evaluationRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metadata).toBeDefined();
  });

  it('rejects with 400 when the body has no questionId', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });

    const res = await POST(makeRequest({ userAnswer: 'Bonjour' }));

    expect(res.status).toBe(400);
  });

  it('rejects with 404 when questionId does not match a stored question', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
    loadQuestionsByIdsMock.mockResolvedValue(new Map());

    const res = await POST(evaluationRequest());

    expect(res.status).toBe(404);
  });

  it('grades against the stored correct answer, ignoring a correctAnswer the body supplies', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
    singleMock.mockResolvedValue({ data: { is_superuser: false }, error: null });

    // A tampered request claiming its own wrong answer is correct (correctAnswer === userAnswer)
    // would grade as an exact match (Tier 2) if the body's correctAnswer were trusted. It reaches
    // the mocked Tier 4 call instead, proving the DB's stored answer ('Bonjour') was used.
    const res = await POST(
      evaluationRequest({ userAnswer: 'Wrong answer', correctAnswer: 'Wrong answer' })
    );
    const body = await res.json();

    expect(callLlmMock).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body.isCorrect).toBe(false);
  });
});

describe('production logging', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.VERCEL_ENV;
    vi.restoreAllMocks();
  });

  it.each(['production', 'preview'] as const)(
    'never logs student-authored question or answer text on a Vercel %s deploy',
    async (vercelEnv) => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.VERCEL_ENV = vercelEnv;

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
      singleMock.mockResolvedValue({ data: { is_superuser: false }, error: null });

      const SECRET_ANSWER = 'UnmistakableStudentAnswerMarker123';
      const SECRET_QUESTION = 'UnmistakableQuestionMarker456';

      loadQuestionsByIdsMock.mockResolvedValue(
        new Map([[QUESTION_ID, { ...DB_QUESTION, question: SECRET_QUESTION, correctAnswer: SECRET_ANSWER }]])
      );

      const res = await POST(evaluationRequest({ userAnswer: SECRET_ANSWER }));

      expect(res.status).toBe(200);

      const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((arg) => JSON.stringify(arg))
        .join('\n');

      expect(everythingLogged).not.toContain(SECRET_ANSWER);
      expect(everythingLogged).not.toContain(SECRET_QUESTION);
    }
  );

  it('rejects a malformed body with 400 without logging any of its text', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.VERCEL_ENV = 'production';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'study-id' });
    singleMock.mockResolvedValue({ data: { is_superuser: false }, error: null });

    const res = await POST(
      new NextRequest('https://example.com/api/evaluate-writing', {
        method: 'POST',
        headers: HEADERS,
        body: '{"userAnswer": UnmistakableMalformedBodyMarker789',
      })
    );

    expect(res.status).toBe(400);

    const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join('\n');

    expect(everythingLogged).not.toContain('UnmistakableMalformedBodyMarker789');
  });
});
