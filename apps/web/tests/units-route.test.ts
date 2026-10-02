import { beforeEach, describe, expect, it, vi } from 'vitest';

const order = vi.fn();
const select = vi.fn(() => ({ order }));
const from = vi.fn(() => ({ select }));

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from },
  isSupabaseAdminAvailable: () => true,
}));

const { GET } = await import('@/app/api/units/route');

beforeEach(() => {
  order.mockReset();
  select.mockClear();
  from.mockClear();
});

describe('GET /api/units', () => {
  it('sets a short CDN cache so unit edits reach users quickly', async () => {
    order.mockResolvedValueOnce({ data: [], error: null });

    const response = await GET();

    expect(response.status).toBe(200);
    const cacheControl = response.headers.get('Cache-Control');
    expect(cacheControl).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=60');
  });
});
