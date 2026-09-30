import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previewSupabaseTarget } from '../src/lib/dispatch/supabase-target-preview';

describe('previewSupabaseTarget', () => {
  const ORIGINAL_ENV = { ...process.env };
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abcdefghijklmnopqrst.supabase.co';
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = { ...ORIGINAL_ENV };
  });

  it('shows confirmed when EXPECTED_SUPABASE_REF matches the resolved target', () => {
    process.env.EXPECTED_SUPABASE_REF = 'abcdefghijklmnopqrst';

    previewSupabaseTarget();

    const printed = logSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(printed).toContain('abcdefghijklmnopqrst');
    expect(printed).toContain('confirmed');
    expect(printed).toContain('EXPECTED_SUPABASE_REF');
    expect(printed).not.toContain('REFUSED');
  });

  it('shows it will be refused when EXPECTED_SUPABASE_REF is unset — guided mode never passes --yes-production', () => {
    delete process.env.EXPECTED_SUPABASE_REF;

    previewSupabaseTarget();

    const printed = logSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(printed).toContain('REFUSED');
  });

  it('shows it will be refused when EXPECTED_SUPABASE_REF is set but does not match', () => {
    process.env.EXPECTED_SUPABASE_REF = 'someotherref00000000';

    previewSupabaseTarget();

    const printed = logSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(printed).toContain('REFUSED');
    expect(printed).toContain('someotherref00000000');
  });

  it('never claims confirmed when the real guard would refuse', () => {
    delete process.env.EXPECTED_SUPABASE_REF;

    previewSupabaseTarget();

    const printed = logSpy.mock.calls.map((call: unknown[]) => call[0]).join('\n');
    expect(printed).not.toContain('confirmed via');
  });

  it('returns true only when a write would be allowed, so callers can stop before running', () => {
    process.env.EXPECTED_SUPABASE_REF = 'abcdefghijklmnopqrst';
    expect(previewSupabaseTarget()).toBe(true);

    delete process.env.EXPECTED_SUPABASE_REF;
    expect(previewSupabaseTarget()).toBe(false);

    process.env.EXPECTED_SUPABASE_REF = 'someotherref00000000';
    expect(previewSupabaseTarget()).toBe(false);
  });
});
