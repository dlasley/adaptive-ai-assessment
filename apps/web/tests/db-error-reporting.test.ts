import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type Result = { data: unknown; error: { code: string; message: string } | null };

const { tables, fromMock } = vi.hoisted(() => {
  const tables: Record<string, Result> = {};

  // A query builder that chains through every filter and resolves to the table's canned result,
  // whether it is awaited directly or ended with single().
  const builder = (table: string) => {
    const result = () => Promise.resolve(tables[table] ?? { data: [], error: null });
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      order: () => q,
      limit: () => q,
      single: result,
      then: (resolve: (value: unknown) => unknown) => result().then(resolve),
    };
    return q;
  };

  return { tables, fromMock: vi.fn((table: string) => builder(table)) };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: vi.fn().mockResolvedValue({ studyCodeId: 'study-id' }),
}));

vi.mock('@/lib/admin-route-guard', () => ({ requireAdmin: () => null }));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: Date.now() + 60_000 }),
  getClientIp: () => '203.0.113.9',
}));

import { GET as superuserGet } from '@/app/api/check-superuser/route';
import { GET as dashboardGet } from '@/app/api/student/dashboard/route';
import { GET as adminCodeGet } from '@/app/api/admin/study-codes/[code]/route';

const DB_ERROR = { code: '08006', message: 'connection failure' };
const NO_ROWS = { code: 'PGRST116', message: 'no rows' };
const STUDY_CODE_ROW = {
  id: 'study-id',
  code: 'happy-elephant',
  display_name: null,
  created_at: '2026-01-01T00:00:00Z',
  total_quizzes: 0,
  total_questions: 0,
  correct_answers: 0,
  is_superuser: false,
  wrong_answer_countdown: null,
};

function get(path: string): NextRequest {
  return new NextRequest(`https://example.com${path}`);
}

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/check-superuser', () => {
  it('reports a database error as 503, not as "not a superuser"', async () => {
    tables.study_codes = { data: null, error: DB_ERROR };

    const res = await superuserGet(get('/api/check-superuser'));

    expect(res.status).toBe(503);
  });
});

describe('GET /api/student/dashboard', () => {
  it('reports a database error on the profile read as 503, not 404', async () => {
    tables.study_codes = { data: null, error: DB_ERROR };

    const res = await dashboardGet(get('/api/student/dashboard'));

    expect(res.status).toBe(503);
  });

  it('answers 404 when the study code row does not exist', async () => {
    tables.study_codes = { data: null, error: NO_ROWS };

    const res = await dashboardGet(get('/api/student/dashboard'));

    expect(res.status).toBe(404);
  });

  it('reports a failed follow-up read as 503 instead of returning empty lists', async () => {
    tables.study_codes = { data: STUDY_CODE_ROW, error: null };
    tables.concept_mastery = { data: null, error: DB_ERROR };

    const res = await dashboardGet(get('/api/student/dashboard'));

    expect(res.status).toBe(503);
  });
});

describe('GET /api/admin/study-codes/[code]', () => {
  const params = { params: Promise.resolve({ code: 'happy-elephant' }) };

  it('reports a database error on the lookup as 503, not 404', async () => {
    tables.study_codes = { data: null, error: DB_ERROR };

    const res = await adminCodeGet(get('/api/admin/study-codes/happy-elephant'), params);

    expect(res.status).toBe(503);
  });

  it('answers 404 when the study code does not exist', async () => {
    tables.study_codes = { data: null, error: NO_ROWS };

    const res = await adminCodeGet(get('/api/admin/study-codes/happy-elephant'), params);

    expect(res.status).toBe(404);
  });

  it.each(['quiz_history', 'concept_mastery', 'weak_topics'])('reports a failed %s read as 503', async (table) => {
    tables.study_codes = { data: STUDY_CODE_ROW, error: null };
    tables[table] = { data: null, error: DB_ERROR };

    const res = await adminCodeGet(get('/api/admin/study-codes/happy-elephant'), params);

    expect(res.status).toBe(503);
  });
});
