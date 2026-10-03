import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A native client passes the unmodified CSRF check by sending the production Origin and a JSON
// Content-Type alongside its bearer token. Every student-reachable CSRF-protected route is called
// in process. Dependencies past the CSRF check are stubbed only so no route reaches a real service;
// what a route answers after the check (generate-code and generate-questions answer 500 against
// these empty stubs) is outside this contract, which asserts only that the check itself passed.

const { builder } = vi.hoisted(() => {
  const builder: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: { id: 'row-id', session_epoch: 1 }, error: null });
        }
        return () => builder;
      },
    },
  );
  return { builder };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: () => builder },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 }),
  getClientIp: () => '203.0.113.9',
  getRateLimitStore: () => ({}),
}));

vi.mock('@/lib/verify-code-guard', () => ({
  codeLockRetryAfterSeconds: vi.fn().mockResolvedValue(null),
  ipLockRetryAfterSeconds: vi.fn().mockResolvedValue(null),
  isInTightenedMode: vi.fn().mockResolvedValue(false),
  recordCodeLookupFailure: vi.fn(),
  recordGlobalLookupFailure: vi.fn(),
  recordIpMiss: vi.fn(),
  tightenedModeRetryAfterSeconds: vi.fn().mockResolvedValue(60),
}));

vi.mock('@/lib/question-loader', () => ({
  loadAllQuestions: vi.fn().mockResolvedValue([]),
  loadQuestionsByIds: vi.fn().mockResolvedValue(new Map()),
  selectQuestions: vi.fn(() => ({ questions: [], warnings: [], requestedCount: 0, actualCount: 0 })),
}));

import { POST as verifyCodePost } from '@/app/api/verify-code/route';
import { POST as generateCodePost } from '@/app/api/generate-code/route';
import { POST as logoutPost } from '@/app/api/student/logout/route';
import { POST as quizResultsPost } from '@/app/api/student/quiz-results/route';
import { POST as leitnerPost } from '@/app/api/student/leitner/route';
import { POST as evaluateWritingPost } from '@/app/api/evaluate-writing/route';
import { POST as generateQuestionsPost } from '@/app/api/generate-questions/route';
import { POST as studyGuidePost } from '@/app/api/study-guide/route';
import { createStudentSessionToken } from '@/lib/student-session';

const PROD_URL = 'pratique.amazingzebra.com';
const QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN_NOT_ALLOWED = { error: 'Origin not allowed' };

const CSRF_PROTECTED: { name: string; handler: (request: NextRequest) => Promise<Response>; body: unknown }[] = [
  { name: 'verify-code', handler: verifyCodePost, body: { code: 'brave purple penguin', platform: 'native' } },
  { name: 'generate-code', handler: generateCodePost, body: { platform: 'native' } },
  { name: 'student/logout', handler: logoutPost, body: {} },
  {
    name: 'student/quiz-results',
    handler: quizResultsPost,
    body: {
      unitId: 'all',
      difficulty: 'beginner',
      totalQuestions: 1,
      correctAnswers: 1,
      scorePercentage: 100,
      questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
      userAnswers: { [QUESTION_ID]: 'Bonjour' },
    },
  },
  { name: 'student/leitner', handler: leitnerPost, body: { questionId: QUESTION_ID, isCorrect: true } },
  { name: 'evaluate-writing', handler: evaluateWritingPost, body: { questionId: QUESTION_ID, userAnswer: 'Bonjour' } },
  { name: 'generate-questions', handler: generateQuestionsPost, body: { numQuestions: 1, leitnerMode: true } },
  { name: 'study-guide', handler: studyGuidePost, body: { incorrectQuestions: [] } },
];

function nativeRequest(name: string, body: unknown, withOrigin: boolean): NextRequest {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: `Bearer ${createStudentSessionToken('study-id', 1)}`,
  });
  if (withOrigin) headers.set('origin', `https://${PROD_URL}`);
  return new NextRequest(`https://${PROD_URL}/api/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe.each(CSRF_PROTECTED)('$name native header contract', ({ name, handler, body }) => {
  it('passes the CSRF check with the production Origin, a JSON Content-Type and a bearer', async () => {
    const res = await handler(nativeRequest(name, body, true));

    expect(res.status).not.toBe(415);
    if (res.status === 403) expect(await res.json()).not.toEqual(ORIGIN_NOT_ALLOWED);
  });

  it('answers 403 Origin not allowed to the same request without an Origin', async () => {
    const res = await handler(nativeRequest(name, body, false));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(ORIGIN_NOT_ALLOWED);
  });
});
