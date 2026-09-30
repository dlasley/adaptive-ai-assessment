import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

/**
 * Proves the fix for a real leak: an unhandled error while loading/selecting questions (which can
 * originate from a Supabase driver message) must not reach the client response body.
 */

const { requireStudentSessionMock } = vi.hoisted(() => ({
  requireStudentSessionMock: vi.fn(),
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: requireStudentSessionMock,
}));

vi.mock('@/lib/feature-flags', () => ({
  FEATURES: { LEITNER_MODE: false },
}));

const SENSITIVE_MESSAGE = 'relation "questions" violates row-level security policy for user db-internal-host-1';

const { loadAllQuestionsMock } = vi.hoisted(() => ({
  loadAllQuestionsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadAllQuestions: loadAllQuestionsMock,
  selectQuestions: vi.fn(),
}));

import { POST } from '@/app/api/generate-questions/route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('https://example.com/api/generate-questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireStudentSessionMock.mockReset();
  loadAllQuestionsMock.mockReset();
  loadAllQuestionsMock.mockRejectedValue(new Error(SENSITIVE_MESSAGE));
});

describe('POST /api/generate-questions error response', () => {
  it('returns a generic error to the client, never the underlying error message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(makeRequest({ unitId: 'all', numQuestions: 5, difficulty: 'beginner' }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain(SENSITIVE_MESSAGE);
    expect(body).toEqual({ error: 'Failed to load questions' });

    errorSpy.mockRestore();
  });
});
