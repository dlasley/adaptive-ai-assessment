import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildMapExistingPrompt, parseMapExistingResponse, MapExistingParseError } from '../src/lib/topics';

/**
 * Byte-exact fixture test for `buildMapExistingPrompt`, the `--map-existing` repair-mode prompt
 * shared by `content-suggest-topics.ts` and any other caller of the mapping prompt. Guards the
 * extraction of this prompt (and `parseMapExistingResponse`) out of the command file into
 * `lib/topics.ts` against accidental drift, the way `content-suggest-topics-prompt.test.ts` guards
 * the topic-extraction prompt.
 */

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('buildMapExistingPrompt', () => {
  const markdown = `<!-- slide 1 -->

## Warm Up
Greetings content.

<!-- slide 2 -->

## Vocabulaire actif
Vocabulary content.
`;

  it('matches the pre-extraction inline template output', () => {
    const result = buildMapExistingPrompt(['Greetings', 'Vocabulary'], markdown);
    expect(result).toBe(fixture('map-existing-prompt.expected.txt'));
  });
});

describe('parseMapExistingResponse', () => {
  it('extracts the topics mapping from a JSON response', () => {
    const text = JSON.stringify({ topics: { Greetings: [{ heading: 'Warm Up', slide: 1 }] } });
    expect(parseMapExistingResponse(text, ['Greetings'])).toEqual({ Greetings: [{ heading: 'Warm Up', slide: 1 }] });
  });

  it('defaults a topic the response omits to an empty array', () => {
    const text = JSON.stringify({ topics: { Greetings: ['Warm Up'] } });
    expect(parseMapExistingResponse(text, ['Greetings', 'Vocabulary'])).toEqual({
      Greetings: ['Warm Up'],
      Vocabulary: [],
    });
  });

  it('throws MapExistingParseError when no JSON object is present', () => {
    expect(() => parseMapExistingResponse('not json', ['Greetings'])).toThrow(MapExistingParseError);
  });
});
