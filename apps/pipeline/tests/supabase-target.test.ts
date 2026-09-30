import { describe, expect, it } from 'vitest';
import { decideSupabaseTarget, resolveSupabaseRef } from '../src/lib/supabase-target';

describe('resolveSupabaseRef', () => {
  it('extracts the ref from a standard project URL', () => {
    expect(resolveSupabaseRef('https://abcdefghijklmnopqrst.supabase.co')).toBe(
      'abcdefghijklmnopqrst',
    );
  });

  it('ignores a trailing slash', () => {
    expect(resolveSupabaseRef('https://abcdefghijklmnopqrst.supabase.co/')).toBe(
      'abcdefghijklmnopqrst',
    );
  });

  it('ignores a path or query string', () => {
    expect(resolveSupabaseRef('https://abcdefghijklmnopqrst.supabase.co/rest/v1?x=1')).toBe(
      'abcdefghijklmnopqrst',
    );
  });

  it('accepts http as well as https', () => {
    expect(resolveSupabaseRef('http://abcdefghijklmnopqrst.supabase.co')).toBe(
      'abcdefghijklmnopqrst',
    );
  });

  it('lowercases the ref', () => {
    expect(resolveSupabaseRef('https://ABCDEFGHIJKLMNOPQRST.supabase.co')).toBe(
      'abcdefghijklmnopqrst',
    );
  });

  it('returns null for a missing URL', () => {
    expect(resolveSupabaseRef(undefined)).toBeNull();
    expect(resolveSupabaseRef(null)).toBeNull();
    expect(resolveSupabaseRef('')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(resolveSupabaseRef('not a url')).toBeNull();
  });

  it('returns null for a non-Supabase hostname', () => {
    expect(resolveSupabaseRef('https://example.com')).toBeNull();
    expect(resolveSupabaseRef('https://supabase.co')).toBeNull();
  });
});

describe('decideSupabaseTarget', () => {
  const url = 'https://abcdefghijklmnopqrst.supabase.co';
  const ref = 'abcdefghijklmnopqrst';

  it('print-only for a read-only call, even with no expected ref or confirmation', () => {
    const decision = decideSupabaseTarget({
      url,
      write: false,
      expectedRef: undefined,
      confirmed: false,
    });

    expect(decision).toEqual({ outcome: 'print-only', ref });
  });

  it('print-only for a read-only call against an unresolved URL', () => {
    const decision = decideSupabaseTarget({
      url: undefined,
      write: false,
      expectedRef: undefined,
      confirmed: false,
    });

    expect(decision).toEqual({ outcome: 'print-only', ref: null });
  });

  it('confirms a write when EXPECTED_SUPABASE_REF matches the resolved ref', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: ref,
      confirmed: false,
    });

    expect(decision).toEqual({ outcome: 'confirmed', ref, via: 'expected-ref-match' });
  });

  it('matches EXPECTED_SUPABASE_REF case-insensitively', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: ref.toUpperCase(),
      confirmed: false,
    });

    expect(decision.outcome).toBe('confirmed');
  });

  it('refuses a write when EXPECTED_SUPABASE_REF does not match', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: 'someotherref00000000',
      confirmed: false,
    });

    expect(decision.outcome).toBe('refused');
    expect(decision).toMatchObject({ ref });
    if (decision.outcome === 'refused') {
      expect(decision.reason).toContain('someotherref00000000');
      expect(decision.reason).toContain(ref);
    }
  });

  it('confirms a write via --yes-production when no EXPECTED_SUPABASE_REF is set', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: undefined,
      confirmed: true,
    });

    expect(decision).toEqual({ outcome: 'confirmed', ref, via: 'yes-production-flag' });
  });

  it('refuses a write when neither EXPECTED_SUPABASE_REF nor --yes-production is set', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: undefined,
      confirmed: false,
    });

    expect(decision.outcome).toBe('refused');
    if (decision.outcome === 'refused') {
      expect(decision.reason).toContain(ref);
    }
  });

  it('lets --yes-production override a mismatched EXPECTED_SUPABASE_REF', () => {
    const decision = decideSupabaseTarget({
      url,
      write: true,
      expectedRef: 'someotherref00000000',
      confirmed: true,
    });

    expect(decision).toEqual({ outcome: 'confirmed', ref, via: 'yes-production-flag' });
  });

  it('refuses a write when the URL is missing entirely, even with --yes-production', () => {
    const decision = decideSupabaseTarget({
      url: undefined,
      write: true,
      expectedRef: undefined,
      confirmed: true,
    });

    expect(decision.outcome).toBe('refused');
    expect(decision.ref).toBeNull();
  });
});
