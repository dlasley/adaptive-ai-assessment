import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/study-guide/route';
import { MAX_QUESTIONS } from '@/lib/api-schemas';

function studyGuideRequest(incorrectQuestions: unknown): NextRequest {
  return new NextRequest('https://example.com/api/study-guide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ incorrectQuestions }),
  });
}

function makeQuestions(count: number) {
  return Array.from({ length: count }, (_, i) => ({ topic: `topic-${i}`, unitId: 'unit-1' }));
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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
});
