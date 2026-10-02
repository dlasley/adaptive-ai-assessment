import { describe, expect, it } from 'vitest';
import { formatDateTimePST } from '@/lib/format-date';

describe('formatDateTimePST', () => {
  it('formats a UTC timestamp in Pacific daylight time', () => {
    expect(formatDateTimePST('2026-10-01T22:05:00Z')).toBe('Oct 1, 2026, 3:05 PM');
  });

  it('formats a UTC timestamp in Pacific standard time', () => {
    expect(formatDateTimePST('2026-01-15T08:30:00Z')).toBe('Jan 15, 2026, 12:30 AM');
  });
});
