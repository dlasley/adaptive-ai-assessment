import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Proves the fix for a real leak: `question_results.user_answer` is student free-text, and
 * Postgres's own DETAIL text for a constraint violation on that table is documented to read
 * `Failing row contains (<every column value>)` — i.e. it can embed the student's answer verbatim.
 * This drives that exact failure shape through the real route and asserts the marker never reaches
 * any console call.
 */

const { MARKER, fromMock, singleMock, insertQuestionResultsMock } = vi.hoisted(() => {
  // Stands in for a head-only exact-count query: awaiting it yields a count.
  const countQuery = () => {
    const query: Record<string, unknown> = {
      eq: vi.fn(() => query),
      then: (resolve: (value: unknown) => unknown) => resolve({ count: 1, error: null }),
    };
    return query;
  };

  const MARKER = 'UNMISTAKABLE_STUDENT_ANSWER_998877';
  const singleMock = vi.fn().mockResolvedValue({ data: { id: 'quiz-history-id' }, error: null });

  // question_results.insert(...) is awaited directly in the route (no .select() chain), so it must
  // itself resolve like a PostgrestFilterBuilder would.
  const insertQuestionResultsMock = vi.fn().mockResolvedValue({
    error: {
      code: '23502',
      message: 'null value in column "topic" of relation "question_results" violates not-null constraint',
      details: `Failing row contains (id, quiz-id, study-id, question-id, ${MARKER}, difficulty, true, correct-answer, 100).`,
      hint: null,
    },
  });

  const fromMock = vi.fn((table: string) => {
    if (table === 'question_results') {
      return {
        select: vi.fn(() => countQuery()),
        insert: insertQuestionResultsMock,
      };
    }
    if (table === 'quiz_history') {
      return {
        insert: vi.fn(() => ({ select: () => ({ single: singleMock }) })),
        select: vi.fn(() => countQuery()),
      };
    }
    if (table === 'study_codes') {
      return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) };
    }
    throw new Error(`unexpected table in test: ${table}`);
  });

  return { MARKER, fromMock, singleMock, insertQuestionResultsMock };
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

const QUESTION_ID = '11111111-1111-1111-1111-111111111111';

const { loadQuestionsByIdsMock } = vi.hoisted(() => ({
  loadQuestionsByIdsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: loadQuestionsByIdsMock,
}));

import { POST as quizResultsPost } from '@/app/api/student/quiz-results/route';

const PROD_URL = 'french-1.vercel.app';
const HEADERS = { 'content-type': 'application/json', origin: `https://${PROD_URL}` };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/student/quiz-results', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });
  singleMock.mockClear();
  insertQuestionResultsMock.mockClear();
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([[QUESTION_ID, { id: QUESTION_ID, correctAnswer: 'Bonjour', topic: 'greetings', difficulty: 'beginner' }]])
  );
});

describe('POST /api/student/quiz-results — Postgres error logging', () => {
  it('never logs a student answer that reached Postgres via a failing-row DETAIL, on a genuine constraint violation', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await quizResultsPost(
      makeRequest({
        unitId: 'unit-1',
        difficulty: 'beginner',
        totalQuestions: 1,
        correctAnswers: 1,
        scorePercentage: 100,
        questions: [
          { id: '11111111-1111-1111-1111-111111111111', topic: 'greetings', difficulty: 'beginner' },
        ],
        userAnswers: { '11111111-1111-1111-1111-111111111111': MARKER },
      })
    );

    // question_results insert failure is non-fatal — quiz history is already saved.
    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalled();

    const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join('\n');

    expect(everythingLogged).not.toContain(MARKER);
  });
});
