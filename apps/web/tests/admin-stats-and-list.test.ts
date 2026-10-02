import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { fromMock, tables } = vi.hoisted(() => {
  const tables: { studyCodes: Record<string, unknown>[]; counts: Record<string, number>; error: boolean } = {
    studyCodes: [],
    counts: {},
    error: false,
  };

  // A select query that is awaitable (head counts) or paged with .range().
  const query = (table: string) => {
    let countKey = table;
    const q: Record<string, unknown> = {
      eq: vi.fn((column: string) => {
        if (column === 'is_correct') countKey = `${table}:correct`;
        return q;
      }),
      gte: vi.fn(() => q),
      lt: vi.fn(() => {
        countKey = `${table}:inactive`;
        return q;
      }),
      order: vi.fn(() => q),
      range: vi.fn((from: number, to: number) =>
        Promise.resolve({ data: tables.studyCodes.slice(from, to + 1), error: null }),
      ),
      then: (resolve: (value: unknown) => unknown) =>
        resolve(
          tables.error
            ? { count: null, error: { code: '57014', message: 'timeout' } }
            : { count: tables.counts[countKey] ?? 0, error: null },
        ),
    };
    return q;
  };

  const fromMock = vi.fn((table: string) => ({ select: vi.fn(() => query(table)) }));
  return { fromMock, tables };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/admin-route-guard', () => ({ requireAdmin: () => null }));

import { GET as statsGet } from '@/app/api/admin/stats/route';
import { GET as listGet } from '@/app/api/admin/study-codes/route';

function request(path: string): NextRequest {
  return new NextRequest(`https://example.com${path}`);
}

beforeEach(() => {
  tables.studyCodes = [];
  tables.counts = {};
  tables.error = false;
});

describe('GET /api/admin/stats', () => {
  it('derives question totals from exact counts rather than a page of study code rows', async () => {
    tables.counts = {
      study_codes: 1500,
      quiz_history: 40,
      question_results: 2000,
      'question_results:correct': 1500,
      'study_codes:inactive': 120,
    };

    const res = await statsGet(request('/api/admin/stats'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.totalQuestions).toBe(2000);
    expect(body.averageAccuracy).toBe(75);
    expect(body.totalStudyCodes).toBe(1500);
    expect(body.inactiveStudyCodes).toBe(120);
  });

  it('answers 500 when a count fails instead of reporting zeros', async () => {
    tables.error = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await statsGet(request('/api/admin/stats'));

    expect(res.status).toBe(500);
  });
});

describe('GET /api/admin/study-codes', () => {
  it('returns every row when there are more than one page of study codes', async () => {
    tables.studyCodes = Array.from({ length: 2300 }, (_, i) => ({
      id: `id-${i}`,
      code: `study-${i}`,
      display_name: null,
      admin_label: null,
      total_quizzes: 0,
      total_questions: 0,
      correct_answers: 0,
      last_active_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    }));

    const res = await listGet(request('/api/admin/study-codes'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2300);
  });
});
