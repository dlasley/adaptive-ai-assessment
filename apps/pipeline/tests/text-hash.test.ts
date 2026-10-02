import { describe, expect, it } from 'vitest';
import { hashText } from '../src/lib/text-hash';

// Prompt hashes are stored in the database, so these outputs must never change.
describe('hashText', () => {
  it.each([
    ['', 'e3b0c44298fc1c14'],
    ['abc', 'ba7816bf8f01cfea'],
    ['Bonjour le monde', '4dc45b5ed3de202a'],
    ['Révision: œuvre', 'e169b91f87776fe2'],
  ])('hashes %j to the first 16 hex characters of its SHA-256', (input, expected) => {
    expect(hashText(input)).toBe(expected);
  });
});
