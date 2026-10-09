import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

const { loadQuestionsByIdsMock } = vi.hoisted(() => ({
  loadQuestionsByIdsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: loadQuestionsByIdsMock,
}));

import { POST } from '@/app/api/evaluate-writing/route';
import { FEATURES } from '@/lib/feature-flags';

const PROD_URL = 'french-1.vercel.app';

// "Bonjuor" is "Bonjour" with one pair of adjacent characters exchanged: not an exact match, but
// the kind of typo the fuzzy tier accepts without a model call.
function answerRequest(userAnswer: string): NextRequest {
  return new NextRequest('https://example.com/api/evaluate-writing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: JSON.stringify({
      questionId: QUESTION_ID,
      userAnswer,
    }),
  });
}

function typoRequest(): NextRequest {
  return answerRequest('Bonjuor');
}

const flags = FEATURES as { SKIP_FUZZY_LOGIC: boolean };
const original = flags.SKIP_FUZZY_LOGIC;

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  singleMock.mockResolvedValue({ data: { is_superuser: true }, error: null });
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([
      [
        QUESTION_ID,
        {
          id: QUESTION_ID,
          question: 'Translate: hello',
          correctAnswer: 'Bonjour',
          difficulty: 'beginner',
          type: 'writing',
          writingType: 'translation',
          acceptableVariations: [],
          unitId: 'unit-1',
          topic: 'greetings',
        },
      ],
    ])
  );
  callLlmMock.mockReset();
  callLlmMock.mockResolvedValue({
    text: JSON.stringify({
      isCorrect: true,
      score: 90,
      hasCorrectAccents: true,
      feedback: 'ok',
      corrections: {},
      confidenceScore: 95,
    }),
  });
});

afterEach(() => {
  flags.SKIP_FUZZY_LOGIC = original;
});

describe('SKIP_FUZZY_LOGIC in /api/evaluate-writing', () => {
  it('grades a near-miss with fuzzy logic and no model call when the flag is off', async () => {
    flags.SKIP_FUZZY_LOGIC = false;

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).not.toHaveBeenCalled();
    expect(body.metadata.evaluationTier).toBe('fuzzy_match');
  });

  it('sends an answer the fuzzy tier does not match on to the model, flag off', async () => {
    flags.SKIP_FUZZY_LOGIC = false;

    const res = await POST(answerRequest('Bonjoir'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(body.metadata.evaluationTier).toBe('semantic');
  });

  it('sends the same near-miss to the model when the flag is on', async () => {
    flags.SKIP_FUZZY_LOGIC = true;

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(body.metadata.evaluationTier).toBe('semantic');
    expect(body.metadata.evaluationReason).toMatch(/disabled by SKIP_FUZZY_LOGIC/);
  });
});
