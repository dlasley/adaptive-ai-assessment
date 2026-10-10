/**
 * Covers the path where every grading-model attempt fails outright (network error, non-2xx, or an
 * LlmError whose message could name the served model) rather than returning malformed JSON. Unlike
 * the parse-failure paths in evaluate-writing-json-retry.test.ts, this asserts the full contract:
 * the student gets the generic operational message (not a raw error), the response and every log
 * call are free of the model id and the question text, and nothing student-authored is logged at
 * error level.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LlmError } from '@adaptive/shared/llm';
import { MODELS } from '@adaptive/shared/models';
import { COURSE_CONTENT } from '@adaptive/shared/course';

const { singleMock, fromMock, callLlmMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const fromMock = vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: singleMock })) })) }));
  const callLlmMock = vi.fn();
  return { singleMock, fromMock, callLlmMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: vi.fn().mockResolvedValue({ studyCodeId: 'study-id' }),
}));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

// The in-memory limiter would count every request in the file against one session.
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 }),
  getClientIp: () => '203.0.113.9',
}));

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION_TEXT = 'Translate: the quick brown fox';
const STUDENT_ANSWER = 'le-renard-marker-xyzzy';

const { loadQuestionsByIdsMock } = vi.hoisted(() => ({
  loadQuestionsByIdsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: loadQuestionsByIdsMock,
}));

import { POST } from '@/app/api/evaluate-writing/route';
import { FEATURES } from '@/lib/feature-flags';

const PROD_URL = 'french-1.vercel.app';

function requestWithAnswer(): NextRequest {
  return new NextRequest('https://example.com/api/evaluate-writing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: JSON.stringify({ questionId: QUESTION_ID, userAnswer: STUDENT_ANSWER }),
  });
}

const flags = FEATURES as { SKIP_FUZZY_LOGIC: boolean };
const original = flags.SKIP_FUZZY_LOGIC;

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  singleMock.mockResolvedValue({ data: { is_superuser: false }, error: null });
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([
      [
        QUESTION_ID,
        {
          id: QUESTION_ID,
          question: QUESTION_TEXT,
          correctAnswer: 'le renard brun rapide',
          difficulty: 'beginner',
          type: 'writing',
          writingType: 'translation',
          acceptableVariations: [],
          unitId: 'unit-1',
          topic: 'animals',
        },
      ],
    ])
  );
  callLlmMock.mockReset();
  flags.SKIP_FUZZY_LOGIC = true;
});

afterEach(() => {
  flags.SKIP_FUZZY_LOGIC = original;
  vi.restoreAllMocks();
});

describe('evaluate-writing when every grading attempt fails', () => {
  it('returns the generic operational message, not a raw error, when callLlm rejects outright', async () => {
    callLlmMock.mockRejectedValue(new Error('ECONNRESET'));

    const res = await POST(requestWithAnswer());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      isCorrect: false,
      score: 50,
      hasCorrectAccents: false,
      feedback: COURSE_CONTENT.feedback.evaluationApiFailed,
      corrections: {},
    });
    expect(body).not.toHaveProperty('gradedBy');
  });

  it('never includes the model id or the question text in the response body', async () => {
    callLlmMock.mockRejectedValue(new Error('ECONNRESET'));

    const res = await POST(requestWithAnswer());
    const raw = JSON.stringify(await res.json());

    expect(raw).not.toContain(MODELS.writingEvaluation);
    expect(raw).not.toContain(QUESTION_TEXT);
  });

  it('logs only the error name at error level, never the message, model id, or question', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    callLlmMock.mockRejectedValue(new Error('ECONNRESET while calling ' + MODELS.writingEvaluation));

    await POST(requestWithAnswer());

    const semanticTierCall = errorSpy.mock.calls.find(([line]) => String(line).includes('Semantic tier error'));
    expect(semanticTierCall).toBeDefined();
    expect(semanticTierCall?.[1]).toEqual({ name: 'Error' });
  });

  it('logs only the error name for an LlmError, stripping its message even when it names the model', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    callLlmMock.mockRejectedValue(
      new LlmError(`upstream 503 from ${MODELS.writingEvaluation}`, 503, { model: MODELS.writingEvaluation })
    );

    await POST(requestWithAnswer());

    const semanticTierCall = errorSpy.mock.calls.find(([line]) => String(line).includes('Semantic tier error'));
    expect(semanticTierCall?.[1]).toEqual({ name: 'LlmError' });
  });

  it('never logs the student-authored answer at any level on a deployed build once every attempt has failed', async () => {
    // Debug-level tracing (which does carry truncated student text) is silenced on any deployed
    // build — see src/lib/logger.ts. Stub that to isolate what THIS code path (warn/error/the
    // info-level outcome line) logs once every grading attempt has failed.
    vi.stubEnv('NODE_ENV', 'production');
    process.env.VERCEL_ENV = 'production';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    callLlmMock.mockRejectedValue(new Error('ECONNRESET'));

    await POST(requestWithAnswer());

    const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join('\n');

    expect(everythingLogged).not.toContain(STUDENT_ANSWER);

    vi.unstubAllEnvs();
    delete process.env.VERCEL_ENV;
  });
});
