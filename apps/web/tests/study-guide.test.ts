import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { checkRateLimitMock } = vi.hoisted(() => ({ checkRateLimitMock: vi.fn() }));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: checkRateLimitMock,
  getClientIp: () => '203.0.113.9',
}));

import { POST } from '@/app/api/study-guide/route';
import { MAX_QUESTIONS } from '@/lib/api-schemas';

const PROD_URL = 'quiz.example.com';

function studyGuideRequest(incorrectQuestions: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://example.com/api/study-guide', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}`, ...headers },
    body: JSON.stringify({ incorrectQuestions }),
  });
}

function makeQuestions(count: number) {
  return Array.from({ length: count }, (_, i) => ({ topic: `topic-${i}`, unitId: 'unit-1' }));
}

beforeEach(() => {
  vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', PROD_URL);
  vi.stubEnv('VERCEL_URL', '');
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (Object.prototype as Record<string, unknown>).count;
});

describe('POST /api/study-guide', () => {
  it('rejects an incorrectQuestions array larger than the per-quiz question cap', async () => {
    const res = await POST(studyGuideRequest(makeQuestions(MAX_QUESTIONS + 1)));

    expect(res.status).toBe(400);
  });

  it('accepts an array at the cap', async () => {
    const res = await POST(studyGuideRequest(makeQuestions(MAX_QUESTIONS)));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });

  it('returns no recommendations for an empty array without hitting the size check', async () => {
    const res = await POST(studyGuideRequest([]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recommendations).toEqual([]);
  });

  it('counts a "__proto__" topic as an ordinary topic and leaves Object.prototype alone', async () => {
    const res = await POST(
      studyGuideRequest([
        { topic: '__proto__', unitId: 'u' },
        { topic: 'constructor', unitId: 'u' },
        { topic: '__proto__', unitId: 'u' },
      ]),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recommendations).toEqual([
      { topic: '__proto__', count: 2, resources: [] },
      { topic: 'constructor', count: 1, resources: [] },
    ]);
    expect(({} as Record<string, unknown>).count).toBeUndefined();
  });

  it.each([
    ['a non-array', 'topics'],
    ['entries that are not objects', ['a']],
    ['a non-string topic', [{ topic: 5, unitId: 'u' }]],
    ['a topic over the length cap', [{ topic: 'x'.repeat(201), unitId: 'u' }]],
  ])('rejects %s with 400', async (_name, payload) => {
    const res = await POST(studyGuideRequest(payload));
    expect(res.status).toBe(400);
  });

  it('rejects a request from a foreign origin', async () => {
    const res = await POST(studyGuideRequest(makeQuestions(1), { origin: 'https://evil.example.org' }));
    expect(res.status).toBe(403);
  });

  it('answers 429 once the per-IP limit is spent', async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 30_000 });
    const res = await POST(studyGuideRequest(makeQuestions(1)));
    expect(res.status).toBe(429);
  });
});
