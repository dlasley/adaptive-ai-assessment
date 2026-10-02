import { describe, expect, it } from 'vitest';
import { chunk } from '../src/lib/array-utils';

describe('chunk', () => {
  it('groups items into fixed-size chunks, with a smaller final chunk', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for an empty input', () => {
    expect(chunk([], 5)).toEqual([]);
  });
});
