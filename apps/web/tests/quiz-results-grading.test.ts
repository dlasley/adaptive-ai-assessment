import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * quiz-results has the same grading-input trust boundary as evaluate-writing (see
 * evaluate-writing.test.ts's "grades against the stored correct answer" test): for question types
 * the server can grade itself (multiple choice, true-false), the persisted is_correct and
 * correct_answer come from the DB-looked-up question, not the request body. Only typed answers
 * (fill-in-blank, writing), which the server cannot grade here, take the client-supplied evaluation.
 */

const { singleMock, insertQuestionResultsMock, studyCodesUpdateMock, fromMock } = vi.hoisted(() => {
  const studyCodesUpdateMock = vi.fn();

  // Stands in for a head-only exact-count query: awaiting it yields the count for the filters applied.
  const countQuery = (counts: { all: number; correct: number }) => {
    let onlyCorrect = false;
    const query: Record<string, unknown> = {
      eq: vi.fn((column: string) => {
        if (column === 'is_correct') onlyCorrect = true;
        return query;
      }),
      then: (resolve: (value: unknown) => unknown) =>
        resolve({ count: onlyCorrect ? counts.correct : counts.all, error: null }),
    };
    return query;
  };

  const singleMock = vi.fn().mockResolvedValue({ data: { id: 'quiz-history-id' }, error: null });
  const insertQuestionResultsMock = vi.fn().mockResolvedValue({ error: null });

  const fromMock = vi.fn((table: string) => {
    if (table === 'question_results') {
      return {
        select: vi.fn(() => countQuery({ all: 1500, correct: 1200 })),
        insert: insertQuestionResultsMock,
      };
    }
    if (table === 'quiz_history') {
      return {
        insert: vi.fn(() => ({ select: () => ({ single: singleMock }) })),
        select: vi.fn(() => countQuery({ all: 7, correct: 7 })),
      };
    }
    if (table === 'units') {
      return { select: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ count: 1, error: null }) })) };
    }
    if (table === 'study_codes') {
      return { update: studyCodesUpdateMock };
    }
    throw new Error(`unexpected table in test: ${table}`);
  });

  return { singleMock, insertQuestionResultsMock, studyCodesUpdateMock, fromMock };
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
const TYPED_QUESTION_ID = '33333333-3333-3333-3333-333333333333';

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

const BASE = {
  unitId: 'unit-1',
  difficulty: 'beginner',
  totalQuestions: 1,
  correctAnswers: 1,
  scorePercentage: 100,
};

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });
  singleMock.mockClear();
  insertQuestionResultsMock.mockClear();
  insertQuestionResultsMock.mockResolvedValue({ error: null });
  studyCodesUpdateMock.mockReset();
  studyCodesUpdateMock.mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([
      [QUESTION_ID, { id: QUESTION_ID, correctAnswer: 'Bonjour', topic: 'greetings', difficulty: 'beginner', type: 'multiple-choice' }],
      [TYPED_QUESTION_ID, { id: TYPED_QUESTION_ID, correctAnswer: 'Salut', topic: 'greetings', difficulty: 'beginner', type: 'fill-in-blank' }],
    ])
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

  it('ignores a client evaluation for a multiple-choice question', async () => {
    const res = await quizResultsPost(
      makeRequest({
        ...BASE,
        questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [QUESTION_ID]: 'Wrong answer' },
        evaluationResults: { [QUESTION_ID]: { isCorrect: true, score: 100 } },
      })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalledWith([
      expect.objectContaining({ question_id: QUESTION_ID, is_correct: false, score: 0 }),
    ]);
  });

  it('takes the client evaluation for a typed answer', async () => {
    const res = await quizResultsPost(
      makeRequest({
        ...BASE,
        questions: [{ id: TYPED_QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [TYPED_QUESTION_ID]: 'Salutations' },
        evaluationResults: { [TYPED_QUESTION_ID]: { isCorrect: true, score: 85 } },
      })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalledWith([
      expect.objectContaining({ question_id: TYPED_QUESTION_ID, is_correct: true, score: 85 }),
    ]);
  });

  it('stores one row for a question id that appears twice', async () => {
    const question = { id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' };
    const res = await quizResultsPost(
      makeRequest({ ...BASE, questions: [question, question], userAnswers: { [QUESTION_ID]: 'Bonjour' } })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock.mock.calls[0][0]).toHaveLength(1);
  });
});

describe('POST /api/student/quiz-results study code totals', () => {
  const submit = () =>
    quizResultsPost(
      makeRequest({
        ...BASE,
        questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [QUESTION_ID]: 'Bonjour' },
      })
    );

  it('writes exact row counts, not the length of a page of rows', async () => {
    const updateEq = vi.fn().mockResolvedValue({ error: null });
    studyCodesUpdateMock.mockReturnValue({ eq: updateEq });

    const res = await submit();

    expect(res.status).toBe(200);
    expect(studyCodesUpdateMock).toHaveBeenCalledWith({
      total_quizzes: 7,
      total_questions: 1500,
      correct_answers: 1200,
    });
    expect(updateEq).toHaveBeenCalledWith('id', 'session-study-id');
  });

  it('logs a failed totals update and still returns the quiz history id', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    studyCodesUpdateMock.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: { code: '42501', message: 'denied' } }),
    });

    const res = await submit();

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error updating study code totals'), expect.anything());
    errorSpy.mockRestore();
  });
});

describe('POST /api/student/quiz-results fields taken from the stored question and unit', () => {
  const unitsCountMock = vi.fn();

  it('stores topic and difficulty from the stored question, not the request body', async () => {
    const res = await quizResultsPost(
      makeRequest({
        ...BASE,
        questions: [{ id: QUESTION_ID, topic: 'any 200 characters the student chose', difficulty: 'advanced' }],
        userAnswers: { [QUESTION_ID]: 'Bonjour' },
      })
    );

    expect(res.status).toBe(200);
    expect(insertQuestionResultsMock).toHaveBeenCalledWith([
      expect.objectContaining({ question_id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }),
    ]);
  });

  it('rejects a unit id that matches no unit, before saving anything', async () => {
    fromMock.mockImplementationOnce((table: string) => {
      expect(table).toBe('units');
      return { select: () => ({ eq: unitsCountMock.mockResolvedValue({ count: 0, error: null }) }) } as never;
    });

    const res = await quizResultsPost(
      makeRequest({
        ...BASE,
        unitId: 'not-a-unit',
        questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [QUESTION_ID]: 'Bonjour' },
      })
    );

    expect(res.status).toBe(400);
    expect(unitsCountMock).toHaveBeenCalledWith('id', 'not-a-unit');
    expect(singleMock).not.toHaveBeenCalled();
    expect(insertQuestionResultsMock).not.toHaveBeenCalled();
  });

  it('accepts the all-units id without looking it up', async () => {
    fromMock.mockClear();
    const res = await quizResultsPost(
      makeRequest({
        ...BASE,
        unitId: 'all',
        questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
        userAnswers: { [QUESTION_ID]: 'Bonjour' },
      })
    );

    expect(res.status).toBe(200);
    expect(fromMock).not.toHaveBeenCalledWith('units');
  });
});
