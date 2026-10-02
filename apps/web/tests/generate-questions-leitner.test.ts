import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { eqMock, fromMock } = vi.hoisted(() => {
  const eqMock = vi.fn().mockResolvedValue({ data: [], error: null });
  const fromMock = vi.fn(() => ({ select: vi.fn(() => ({ eq: eqMock })) }));
  return { eqMock, fromMock };
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/generate-questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  eqMock.mockClear();
  fromMock.mockClear();
  requireStudentSessionMock.mockReset();
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
