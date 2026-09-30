import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeGenerationPromptHash, renderValidationPrompt, renderGenerationPrompt } from '../src/commands/questions-generate';

/**
 * Behavior-preservation test for extracting the validation and generation
 * prompts out of inline template literals into apps/pipeline/prompts/*.md.
 *
 * Each fixture in tests/fixtures/ is the exact byte-for-byte output the old
 * inline template literal produced for the given fixed inputs, captured by
 * running the pre-extraction code before it was deleted. This test compares
 * that frozen output against the new file+placeholder renderer, run with the
 * same inputs, so a mismatch here means the extraction changed behavior.
 */

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');
}

describe('renderValidationPrompt', () => {
  it('matches the pre-extraction inline template output', () => {
    expect(renderValidationPrompt()).toBe(fixture('questions-validate.expected.txt'));
  });
});

describe('renderGenerationPrompt', () => {
  it('matches the pre-extraction output with no writingType/questionType/allowedTypes', () => {
    const result = renderGenerationPrompt({
      topic: 'Adjective Agreement',
      difficulty: 'intermediate',
      topicContent: 'Sample topic content about adjectives.',
      numQuestions: 8,
    });
    expect(result).toBe(fixture('questions-generate-1.expected.txt'));
  });

  it('matches the pre-extraction output with a pinned writingType', () => {
    const result = renderGenerationPrompt({
      topic: 'Adjective Agreement',
      difficulty: 'advanced',
      topicContent: 'Sample topic content about adjectives.',
      numQuestions: 5,
      writingType: 'conjugation',
    });
    expect(result).toBe(fixture('questions-generate-2.expected.txt'));
  });

  it('matches the pre-extraction output with allowedTypes', () => {
    const result = renderGenerationPrompt({
      topic: 'Numbers',
      difficulty: 'beginner',
      topicContent: 'Sample topic content about numbers.',
      numQuestions: 3,
      allowedTypes: ['multiple-choice', 'true-false'],
    });
    expect(result).toBe(fixture('questions-generate-3.expected.txt'));
  });

  it('matches the pre-extraction output with a pinned questionType', () => {
    const result = renderGenerationPrompt({
      topic: 'Numbers',
      difficulty: 'beginner',
      topicContent: 'Sample topic content about numbers.',
      numQuestions: 3,
      questionType: 'fill-in-blank',
    });
    expect(result).toBe(fixture('questions-generate-4.expected.txt'));
  });
});

describe('computeGenerationPromptHash', () => {
  it('returns a deterministic 16-character hex string', () => {
    const hash = computeGenerationPromptHash();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(computeGenerationPromptHash()).toBe(hash);
  });
});
