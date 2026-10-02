import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { fromMock, resetSupabaseMock, singleMock, upsertMock, insertMock, maybeSingleMock } = vi.hoisted(() => {
  const singleMock = vi.fn().mockResolvedValue({ data: null, error: null });
  const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });
  const upsertMock = vi.fn().mockResolvedValue({ error: null });
  const insertMock = vi.fn(() => ({
    select: () => ({ single: singleMock }),
  }));

  const fromMock = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({ maybeSingle: maybeSingleMock })),
        single: singleMock,
        order: vi.fn(() => ({ limit: vi.fn().mockResolvedValue({ data: [] }) })),
      })),
    })),
    insert: insertMock,
    upsert: upsertMock,
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
  }));

  function resetSupabaseMock() {
    singleMock.mockReset().mockResolvedValue({ data: null, error: null });
    maybeSingleMock.mockReset().mockResolvedValue({ data: null, error: null });
    upsertMock.mockReset().mockResolvedValue({ error: null });
    insertMock.mockClear();
    fromMock.mockClear();
  }

  return { fromMock, resetSupabaseMock, singleMock, upsertMock, insertMock, maybeSingleMock };
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

import { GET as dashboardGet } from '@/app/api/student/dashboard/route';
import { POST as quizResultsPost } from '@/app/api/student/quiz-results/route';
import { POST as leitnerPost } from '@/app/api/student/leitner/route';
import { POST as logoutPost } from '@/app/api/student/logout/route';

const PROD_URL = 'french-1.vercel.app';
const JSON_HEADERS = {
  'content-type': 'application/json',
  origin: `https://${PROD_URL}`,
};

function jsonRequest(url: string, body?: unknown, cookie?: string): NextRequest {
  const headers = new Headers(JSON_HEADERS);
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const validQuizResultsBody = {
  unitId: 'all',
  difficulty: 'beginner' as const,
  totalQuestions: 1,
  correctAnswers: 1,
  scorePercentage: 100,
  questions: [{ id: '11111111-1111-1111-1111-111111111111', topic: 'greetings', difficulty: 'beginner', correctAnswer: 'Bonjour' }],
  userAnswers: { '11111111-1111-1111-1111-111111111111': 'Bonjour' },
};

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  resetSupabaseMock();
  requireStudentSessionMock.mockReset();
  singleMock.mockResolvedValue({
    data: { id: 'quiz-history-id' },
    error: null,
  });
});

describe('GET /api/student/dashboard rate limit', () => {
  it('limits each session to 30 requests a minute', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'dashboard-rate-session' });
    singleMock.mockResolvedValue({ data: null, error: null });

    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await dashboardGet(new NextRequest('https://example.com/api/student/dashboard'))).status;
    }

    expect(last).toBe(429);
  });
});

describe('auth gating: no session means the database is never touched', () => {
  it('dashboard: 401 without querying the database', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await dashboardGet(new NextRequest('https://example.com/api/student/dashboard'));

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('quiz-results: 401 without querying the database', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', validQuizResultsBody)
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('leitner: 401 without querying the database', async () => {
    requireStudentSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    );

    const res = await leitnerPost(
      jsonRequest('https://example.com/api/student/leitner', {
        questionId: '11111111-1111-4111-8111-111111111111',
        isCorrect: true,
      })
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });
});

describe('session identity cannot be overridden by the request body', () => {
  it('quiz-results scopes every write to the session studyCodeId, ignoring a body-smuggled one', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });

    const bodyWithSmuggledId = { ...validQuizResultsBody, studyCodeId: 'attacker-study-id' };
    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', bodyWithSmuggledId)
    );

    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ study_code_id: 'session-study-id' })
    );
  });

  it('leitner scopes the upsert to the session studyCodeId, ignoring a body-smuggled one', async () => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });

    const res = await leitnerPost(
      jsonRequest('https://example.com/api/student/leitner', {
        questionId: '11111111-1111-4111-8111-111111111111',
        isCorrect: true,
        studyCodeId: 'attacker-study-id',
      })
    );

    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ study_code_id: 'session-study-id' }),
      expect.anything()
    );
  });
});

describe('POST /api/student/quiz-results body validation', () => {
  beforeEach(() => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });
  });

  it('rejects an out-of-range difficulty enum', async () => {
    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', {
        ...validQuizResultsBody,
        difficulty: 'expert',
      })
    );
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized questions array', async () => {
    const question = validQuizResultsBody.questions[0];
    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', {
        ...validQuizResultsBody,
        questions: Array.from({ length: 101 }, () => question),
      })
    );
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized answer string', async () => {
    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', {
        ...validQuizResultsBody,
        userAnswers: { '11111111-1111-1111-1111-111111111111': 'a'.repeat(2001) },
      })
    );
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong-typed field', async () => {
    const res = await quizResultsPost(
      jsonRequest('https://example.com/api/student/quiz-results', {
        ...validQuizResultsBody,
        totalQuestions: 'one',
      })
    );
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/student/leitner body validation', () => {
  beforeEach(() => {
    requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });
  });

  it('rejects a non-UUID questionId', async () => {
    const res = await leitnerPost(
      jsonRequest('https://example.com/api/student/leitner', {
        questionId: 'not-a-uuid',
        isCorrect: true,
      })
    );
    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('rejects a wrong-typed isCorrect', async () => {
    const res = await leitnerPost(
      jsonRequest('https://example.com/api/student/leitner', {
        questionId: '11111111-1111-4111-8111-111111111111',
        isCorrect: 'yes',
      })
    );
    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/student/logout', () => {
  it('clears the cookie and returns success with no session present', async () => {
    const res = await logoutPost(
      new NextRequest('https://example.com/api/student/logout', {
        method: 'POST',
        headers: JSON_HEADERS,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.cookies.get('student_session')?.value).toBe('');
  });

  it('clears the cookie and returns success with a valid session present', async () => {
    const res = await logoutPost(
      jsonRequest('https://example.com/api/student/logout', undefined, 'student_session=some-valid-looking-token')
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(res.cookies.get('student_session')?.value).toBe('');
  });
});
