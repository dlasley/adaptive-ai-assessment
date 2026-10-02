import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Question } from '@adaptive/shared/types';

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: () => '203.0.113.9',
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: vi.fn(),
}));

function makeBank(size: number): Question[] {
  return Array.from({ length: size }, (_, i) => ({
    id: `q${i}`,
    unitId: 'unit-1',
    type: 'multiple-choice',
    question: `Q${i}?`,
    correctAnswer: 'A',
    difficulty: 'beginner',
    topic: 'greetings',
  })) as Question[];
}

vi.mock('@/lib/question-loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/question-loader')>()),
  loadAllQuestions: vi.fn().mockImplementation(async () => makeBank(40)),
}));

import { POST } from '@/app/api/generate-questions/route';

const PROD_URL = 'quiz.example.com';

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/generate-questions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID = { unitId: 'unit-1', numQuestions: 5, difficulty: 'beginner', mode: 'practice' };

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });
});

describe('POST /api/generate-questions input validation', () => {
  it('serves a valid request', async () => {
    const res = await POST(makeRequest(VALID));
    expect(res.status).toBe(200);
    expect((await res.json()).questions).toHaveLength(5);
  });

  it.each([
    ['a negative count', { numQuestions: -1 }],
    ['a zero count', { numQuestions: 0 }],
    ['a fractional count', { numQuestions: 2.5 }],
    ['a count above the per-quiz cap', { numQuestions: 101 }],
    ['a string count', { numQuestions: '5' }],
    ['a null count (NaN from the client)', { numQuestions: null }],
    ['a prototype key as the mode', { mode: '__proto__' }],
    ['an unknown mode', { mode: 'exam' }],
    ['an unknown difficulty', { difficulty: 'expert' }],
  ])('rejects %s with 400', async (_name, override) => {
    const res = await POST(makeRequest({ ...VALID, ...override }));
    expect(res.status).toBe(400);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await POST(makeRequest('not json'));
    expect(res.status).toBe(400);
  });

  it('rejects a request from a foreign origin', async () => {
    const res = await POST(makeRequest(VALID, { origin: 'https://evil.example.org' }));
    expect(res.status).toBe(403);
  });

  it('answers 429 once the per-IP limit is spent', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 });
    const res = await POST(makeRequest(VALID));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      'generate-questions:203.0.113.9',
      expect.objectContaining({ maxRequests: expect.any(Number) }),
    );
  });
});
