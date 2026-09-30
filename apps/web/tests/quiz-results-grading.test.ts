import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * quiz-results has the same grading-input trust boundary as evaluate-writing (see
 * evaluate-writing.test.ts's "grades against the stored correct answer" test): the persisted
 * is_correct/correct_answer must come from the DB-looked-up question, not the request body.
 */

const { singleMock, insertQuestionResultsMock, fromMock } = vi.hoisted(() => {
  const singleMock = vi.fn().mockResolvedValue({ data: { id: 'quiz-history-id' }, error: null });
  const insertQuestionResultsMock = vi.fn().mockResolvedValue({ error: null });

  const fromMock = vi.fn((table: string) => {
    if (table === 'question_results') {
      return {
        select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: [{ is_correct: true }], error: null }) })),
        insert: insertQuestionResultsMock,
      };
    }
    if (table === 'quiz_history') {
      return {
        insert: vi.fn(() => ({ select: () => ({ single: singleMock }) })),
        select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'quiz-history-id' }], error: null }) })),
      };
    }
    if (table === 'study_codes') {
      return { update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })) };
    }
    throw new Error(`unexpected table in test: ${table}`);
  });

  return { singleMock, insertQuestionResultsMock, fromMock };
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
const UNKNOWN_QUESTION_ID = '22222222-2222-2222-2222-222222222222';

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
  insertQuestionResultsMock.mockResolvedValue({ error: null });
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([[QUESTION_ID, { id: QUESTION_ID, correctAnswer: 'Bonjour', topic: 'greetings', difficulty: 'beginner' }]])
  );
});

describe('POST /api/student/quiz-results — grading correctness', () => {
  it('grades against the DB-stored correct answer; a tampered client answer cannot mark a wrong answer correct', async () => {
    const res = await quizResultsPost(
      makeRequest({
        unitId: 'unit-1',
        difficulty: 'beginner',
        totalQuestions: 1,
        correctAnswers: 1,
        scorePercentage: 100,
        questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [QUESTION_ID]: 'Wrong answer' },
      })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        question_id: QUESTION_ID,
        is_correct: false,
        correct_answer: 'Bonjour',
        user_answer: 'Wrong answer',
      }),
    ]);
  });

  it('skips a question id absent from the stored-question lookup rather than inserting it or failing the request', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await quizResultsPost(
      makeRequest({
        unitId: 'unit-1',
        difficulty: 'beginner',
        totalQuestions: 2,
        correctAnswers: 1,
        scorePercentage: 50,
        questions: [
          { id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' },
          { id: UNKNOWN_QUESTION_ID, topic: 'greetings', difficulty: 'beginner' },
        ],
        userAnswers: { [QUESTION_ID]: 'Bonjour', [UNKNOWN_QUESTION_ID]: 'Bonjour' },
      })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalledTimes(1);
    const insertedRows = insertQuestionResultsMock.mock.calls[0][0];
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0].question_id).toBe(QUESTION_ID);

    const warnedIds = warnSpy.mock.calls.map(([, data]) => (data as { questionId?: string })?.questionId);
    expect(warnedIds).toContain(UNKNOWN_QUESTION_ID);

    warnSpy.mockRestore();
  });
});
