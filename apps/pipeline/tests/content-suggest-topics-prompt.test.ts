import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderTopicPrompt } from '../src/commands/content-suggest-topics';

/**
 * Tests for content-suggest-topics.ts's topic prompt rendering. The fixture is
 * the exact expected prompt for fixed inputs, byte for byte.
 */

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('renderTopicPrompt', () => {
  it('matches the pre-extraction inline template output', () => {
    const result = renderTopicPrompt(
      ['Existing Topic A', 'Existing Topic B'],
      'Some markdown content here.\n\nMore content.'
    );
    expect(result).toBe(fixture('content-suggest-topics.expected.txt'));
  });

  it('includes the whole unit, including sections past the first 20,000 characters', () => {
    const markdown = `${'x'.repeat(30_000)}\n## Late Section Marker\n`;
    const result = renderTopicPrompt([], markdown);
    expect(result).toContain('## Late Section Marker');
    expect(result).not.toContain('[Content truncated');
  });

  it('refuses a unit too large to send whole instead of truncating it', () => {
    expect(() => renderTopicPrompt([], 'x'.repeat(200_001))).toThrow(/over the 200000-character limit/);
  });
});
