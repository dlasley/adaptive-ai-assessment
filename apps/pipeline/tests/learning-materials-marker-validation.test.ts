import { describe, expect, it } from 'vitest';
import { assertValidSlideMarkers } from '../src/lib/learning-materials';

/**
 * `assertValidSlideMarkers` is called wherever unit markdown is read from disk, before anything
 * scans it for slide markers. It accepts only `<!-- slide N -->` comments, with N starting at 1
 * and strictly increasing with no repeats — any other numbered marker comment, or a slide sequence
 * that skips backward or repeats a number, is refused rather than silently misread.
 */

const VALID_MD = `<!-- slide 1 -->

## Warm Up
First section.

<!-- slide 2 -->

## Exercices
Second section.

<!-- slide 5 -->

## Culture
Third section, gaps between marker numbers are fine as long as they keep increasing.
`;

describe('assertValidSlideMarkers', () => {
  it('accepts a document whose slide markers start at 1 and strictly increase', () => {
    expect(() => assertValidSlideMarkers(VALID_MD, 'unit-1.md')).not.toThrow();
  });

  it('accepts a document with no markers at all', () => {
    expect(() => assertValidSlideMarkers('## Just A Heading\nSome content.\n', 'unit-1.md')).not.toThrow();
  });

  it('refuses a numbered marker comment whose word is not "slide", naming the file and line', () => {
    const markdown = `<!-- slide 1 -->

## Warm Up
First section.

<!-- section 2 -->

## Exercices
Second section.
`;
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/unit-1\.md, line 6/);
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/unrecognized marker/);
  });

  it('refuses a slide sequence that does not start at 1', () => {
    const markdown = `<!-- slide 3 -->

## Warm Up
First section.
`;
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/unit-1\.md, line 1/);
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/must start at/);
  });

  it('refuses a slide number that goes backward', () => {
    const markdown = `<!-- slide 1 -->

## Warm Up
First section.

<!-- slide 2 -->

## Exercices
Second section.

<!-- slide 1 -->

## Culture
Repeats slide 1, out of order.
`;
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/unit-1\.md, line 11/);
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/out of order/);
  });

  it('refuses a repeated slide number', () => {
    const markdown = `<!-- slide 1 -->

## Warm Up
First section.

<!-- slide 2 -->

## Exercices
Second section.

<!-- slide 2 -->

## Culture
Duplicates slide 2.
`;
    expect(() => assertValidSlideMarkers(markdown, 'unit-1.md')).toThrow(/out of order/);
  });
});
