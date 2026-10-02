import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const from = vi.fn();
const checkRateLimit = vi.fn();

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit,
  getClientIp: () => '203.0.113.7',
}));

const { POST } = await import('@/app/api/generate-code/route');

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://french-1.vercel.app/api/generate-code', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = 'french-1.vercel.app';
  process.env.STUDENT_SESSION_SECRET = 'test-student-secret-0123456789abcdef012345';
  delete process.env.VERCEL_URL;
  from.mockReset();
  checkRateLimit.mockReset();
});

describe('POST /api/generate-code CSRF protection', () => {
  it('rejects a cross-site request before rate limiting or touching the database', async () => {
    const response = await POST(
      makeRequest({ origin: 'https://evil.com', 'content-type': 'application/json' })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects a form-style request that is not JSON', async () => {
    const response = await POST(
      makeRequest({ origin: 'https://french-1.vercel.app', 'content-type': 'text/plain' })
    );

    expect(response.status).toBe(415);
    expect(from).not.toHaveBeenCalled();
  });
});

const ADJECTIVES = ['brave', 'purple', 'plucky', 'calm'];
const ANIMALS = ['penguin', 'panda', 'otter'];

/** Stands in for study_code_source_words and study_codes, enough for the generator's queries. */
function wirePools(options: { insertErrors?: string[] } = {}) {
  const inserted: string[] = [];
  const insertErrors = [...(options.insertErrors ?? [])];
  const pool = (category: string) => (category === 'adjective' ? ADJECTIVES : ANIMALS);

  from.mockImplementation((table: string) => {
    if (table === 'study_codes') {
      return {
        insert: ({ code }: { code: string }) => ({
          select: () => ({
            single: async () => {
              const errorCode = insertErrors.shift();
              if (errorCode) return { data: null, error: { code: errorCode } };
              inserted.push(code);
              return { data: { id: 'new-id', session_epoch: 1 }, error: null };
            },
          }),
        }),
      };
    }
    return {
      select: (_columns: string, opts?: { head?: boolean }) => {
        const state: { category?: string; letter?: string } = {};
        const rows = () =>
          pool(state.category!)
            .filter((word) => !state.letter || word[0] === state.letter)
            .map((word) => ({ word, first_letter: word[0] }));
        const builder: Record<string, unknown> = {
          eq: (column: string, value: string) => {
            if (column === 'category') state.category = value;
            if (column === 'first_letter') state.letter = value;
            return builder;
          },
          range: (offset: number) => ({ single: async () => ({ data: rows()[offset], error: null }) }),
          then: (resolve: (value: unknown) => unknown) =>
            resolve(opts?.head ? { count: rows().length, error: null } : { data: rows(), error: null }),
        };
        return builder;
      },
    };
  });
  return { inserted };
}

function allowAll() {
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 });
}

const validRequest = () => makeRequest({ origin: 'https://french-1.vercel.app', 'content-type': 'application/json' });

describe('POST /api/generate-code code format', () => {
  it('issues two different adjectives and an animal that shares the second adjective\'s letter when one exists', async () => {
    allowAll();
    const { inserted } = wirePools();

    for (let i = 0; i < 200; i++) {
      const response = await POST(validRequest());
      expect(response.status).toBe(200);
      const { code } = await response.json();
      const [first, second, animal, ...rest] = code.split(' ');

      expect(rest).toEqual([]);
      expect(ADJECTIVES).toContain(first);
      expect(ADJECTIVES).toContain(second);
      expect(ANIMALS).toContain(animal);
      expect(first).not.toBe(second);
      if (second.startsWith('p')) expect(animal.startsWith('p')).toBe(true);
    }
    expect(inserted).toHaveLength(200);
  });

  it('falls back to any animal when none shares the second adjective\'s letter', async () => {
    allowAll();
    wirePools();
    const randomSpy = vi.spyOn(Math, 'random');
    // Second adjective 'calm' (index 3), then an animal from the fallback draw, then a first adjective.
    randomSpy.mockReturnValueOnce(0.9).mockReturnValueOnce(0.5).mockReturnValueOnce(0);

    const response = await POST(validRequest());
    const { code } = await response.json();

    expect(code).toBe('brave calm panda');
    randomSpy.mockRestore();
  });

  it('retries with a new draw after a unique-constraint collision', async () => {
    allowAll();
    const { inserted } = wirePools({ insertErrors: ['23505'] });

    const response = await POST(validRequest());

    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
  });
});

describe('POST /api/generate-code rate limits', () => {
  it('limits each IP per minute and per day', async () => {
    allowAll();
    wirePools();

    await POST(validRequest());

    expect(checkRateLimit).toHaveBeenCalledWith('generate-code-minute:203.0.113.7', { windowMs: 60_000, maxRequests: 30 });
    expect(checkRateLimit).toHaveBeenCalledWith('generate-code-day:203.0.113.7', { windowMs: 86_400_000, maxRequests: 100 });
  });

  it('answers 429 with Retry-After once the daily cap is spent, without issuing a code', async () => {
    const { inserted } = wirePools();
    checkRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 5, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 3_600_000 });

    const response = await POST(validRequest());

    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(3000);
    expect(inserted).toEqual([]);
  });
});
