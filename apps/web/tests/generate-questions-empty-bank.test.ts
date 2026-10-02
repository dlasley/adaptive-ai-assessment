import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { requireStudentSessionMock } = vi.hoisted(() => ({
  requireStudentSessionMock: vi.fn(),
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: requireStudentSessionMock,
}));

vi.mock('@/lib/question-loader', () => ({
  loadAllQuestions: vi.fn().mockResolvedValue([]),
  selectQuestions: vi.fn(),
}));

import { POST } from '@/app/api/generate-questions/route';

beforeEach(() => {
  requireStudentSessionMock.mockReset();
  requireStudentSessionMock.mockResolvedValue({ studyCodeId: 'session-study-id' });
});

describe('POST /api/generate-questions with an empty question bank', () => {
  it('returns 500 with a plain error and no operator instructions', async () => {
    const res = await POST(
      new NextRequest('https://example.com/api/generate-questions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ unitId: 'all', numQuestions: 1, difficulty: 'beginner' }),
      })
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'No questions available' });
  });
});
