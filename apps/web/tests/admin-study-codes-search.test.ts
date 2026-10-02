import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { rangeMock, fromMock } = vi.hoisted(() => {
  const rangeMock = vi.fn().mockResolvedValue({
    data: [
      { code: 'curious-otter', display_name: 'Alice', admin_label: null, total_questions: 0, correct_answers: 0, total_quizzes: 0, last_active_at: null, created_at: null },
      { code: 'happy-fox', display_name: null, admin_label: 'VIP, watch closely', total_questions: 0, correct_answers: 0, total_quizzes: 0, last_active_at: null, created_at: null },
    ],
    error: null,
  });
  const query = { order: vi.fn(() => query), range: rangeMock };
  const fromMock = vi.fn(() => ({ select: vi.fn(() => query) }));
  return { rangeMock, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/admin-route-guard', () => ({
  requireAdmin: () => null,
}));

import { GET } from '@/app/api/admin/study-codes/route';

beforeEach(() => {
  rangeMock.mockClear();
  fromMock.mockClear();
});

describe('GET /api/admin/study-codes search', () => {
  it('filters case-insensitively across code, display name, and admin label', async () => {
    const res = await GET(new NextRequest('https://example.com/api/admin/study-codes?q=otter'));
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].code).toBe('curious-otter');
  });

  it('treats a comma in the search term as a literal substring, not a filter delimiter', async () => {
    const res = await GET(new NextRequest('https://example.com/api/admin/study-codes?q=VIP, watch'));
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].code).toBe('happy-fox');
  });

  it('returns every row when no search term is given', async () => {
    const res = await GET(new NextRequest('https://example.com/api/admin/study-codes'));
    const body = await res.json();

    expect(body).toHaveLength(2);
  });
});
