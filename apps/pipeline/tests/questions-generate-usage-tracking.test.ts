import { describe, expect, it, vi } from 'vitest';

const { callLlmMock } = vi.hoisted(() => ({ callLlmMock: vi.fn() }));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

const SAMPLE_MD = `## Real Heading
Content that exists in the document.
`;

vi.mock('../src/lib/learning-materials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/learning-materials')>()),
  loadUnitMaterials: vi.fn(() => SAMPLE_MD),
}));

import { generateQuestionsForTopic } from '../src/commands/questions-generate';

const UNITS = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Real Topic', headings: ['Real Heading'] }] }];

function generationResponse(usage?: Partial<{ promptTokens: number; completionTokens: number; costUsd: number }>) {
  return {
    text: JSON.stringify({
      questions: [{
        id: 'q1',
        question: 'Vrai ou Faux: proposition.',
        type: 'true-false',
        options: ['Vrai', 'Faux'],
        correctAnswer: 'Vrai',
        explanation: 'ok',
      }],
    }),
    usage,
  };
}

function validationResponse(usage?: Partial<{ promptTokens: number; completionTokens: number; costUsd: number }>) {
  return {
    text: JSON.stringify({ results: [{ id: 'q1', answer_valid: true, acceptable_variations: [], notes: 'OK' }] }),
    usage,
  };
}

describe('generateQuestionsForTopic — usage capture', () => {
  it('records one generation call and one validation call with their usage', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse({ promptTokens: 500, completionTokens: 100, costUsd: 0.01 }))
      .mockResolvedValueOnce(validationResponse({ promptTokens: 200, completionTokens: 50, costUsd: 0.005 }));

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1');

    expect(result.usage.generation).toEqual({
      calls: 1, prompt_tokens: 500, completion_tokens: 100, reasoning_tokens: 0, cost_usd: 0.01, byok_calls: 0, json_failures: 0,
    });
    expect(result.usage.validation).toEqual({
      calls: 1, prompt_tokens: 200, completion_tokens: 50, reasoning_tokens: 0, cost_usd: 0.005, byok_calls: 0, json_failures: 0,
    });
  });

  it('records a generation call and a json_failure without throwing away the usage already spent', async () => {
    callLlmMock.mockResolvedValueOnce({ text: 'not json at all', usage: { promptTokens: 300, completionTokens: 10, costUsd: 0.002 } });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1');

    expect(result.questions).toEqual([]);
    expect(result.usage.generation.calls).toBe(1);
    expect(result.usage.generation.json_failures).toBe(1);
    expect(result.usage.generation.cost_usd).toBe(0.002);
  });

  it('does not record a call when callLlm itself throws (no response, no usage)', async () => {
    callLlmMock.mockRejectedValueOnce(new Error('network error'));

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1');

    expect(result.usage.generation.calls).toBe(0);
    expect(result.usage.generation.json_failures).toBe(0);
  });

  it('records a validation call and json_failure when its response has no JSON object', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse({ promptTokens: 500, completionTokens: 100, costUsd: 0.01 }))
      .mockResolvedValueOnce({ text: 'not json', usage: { promptTokens: 100, completionTokens: 5, costUsd: 0.001 } });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1');

    expect(result.usage.validation.calls).toBe(1);
    expect(result.usage.validation.json_failures).toBe(1);
    expect(result.usage.validation.cost_usd).toBe(0.001);
  });

  it('returns zeroed usage without any calls when the topic has no content (generation never runs)', async () => {
    const units = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Ghost Topic', headings: ['Missing'] }] }];

    const result = await generateQuestionsForTopic('unit-1', 'Ghost Topic', 'beginner', 1, units, 'batch-1');

    expect(callLlmMock).not.toHaveBeenCalled();
    expect(result.usage.generation.calls).toBe(0);
    expect(result.usage.validation.calls).toBe(0);
  });

  it('records no validation call when skipValidation is set', async () => {
    callLlmMock.mockResolvedValueOnce(generationResponse({ promptTokens: 500, completionTokens: 100, costUsd: 0.01 }));

    const result = await generateQuestionsForTopic(
      'unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1',
      undefined, undefined, undefined, undefined, /* skipValidation */ true,
    );

    expect(result.usage.generation.calls).toBe(1);
    expect(result.usage.validation.calls).toBe(0);
  });
});
