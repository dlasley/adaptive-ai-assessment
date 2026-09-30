import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { PROMPTS_DIR } from '../src/lib/paths';

/**
 * Byte-exact fixture test for the two audit system prompts, rendered by the real
 * `renderCoursePrompt()` renderer `questions-audit.ts` uses. Guards the reference-material
 * grounding guidance, the answer-key-by-text rule, and the register/difficulty separation against
 * accidental drift the way `questions-generate-prompts.test.ts` guards the generation prompt.
 */

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('audit-mistral prompt', () => {
  it('matches the expected rendered output, including reference-material and answer-key guidance', () => {
    const raw = readFileSync(join(PROMPTS_DIR, 'audit-mistral.md'), 'utf-8');
    expect(renderCoursePrompt(raw)).toBe(fixture('audit-mistral.expected.txt'));
  });
});

describe('audit-sonnet prompt', () => {
  it('matches the expected rendered output, including reference-material and answer-key guidance', () => {
    const raw = readFileSync(join(PROMPTS_DIR, 'audit-sonnet.md'), 'utf-8');
    expect(renderCoursePrompt(raw)).toBe(fixture('audit-sonnet.expected.txt'));
  });
});
