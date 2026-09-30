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

function generationResponse(count: number) {
  return {
    text: JSON.stringify({
      questions: Array.from({ length: count }, (_, i) => ({
        id: `q${i + 1}`,
        question: `Vrai ou Faux: proposition ${i + 1}.`,
        type: 'true-false',
        options: ['Vrai', 'Faux'],
        correctAnswer: 'Vrai',
        explanation: 'ok',
      })),
    }),
  };
}

/**
 * `generateQuestionsForTopic` calls `callLlm` once for generation, then once per validation
 * batch (unless `skipValidation`). Every test here supplies both in order.
 */
describe('generateQuestionsForTopic — validation result matching', () => {
  it('matches validation results to questions by id, not array position', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(2))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [
            // Deliberately out of order — id matching must not depend on array position.
            { id: 'q2', answer_valid: true, acceptable_variations: [], notes: 'OK' },
            { id: 'q1', answer_valid: true, acceptable_variations: [], notes: 'OK' },
          ],
        }),
      });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 2, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(2);
    expect(result.stats.validation_unmatched).toBe(0);
    expect(result.stats.validation_errors).toBe(0);
  });

  it('rejects (as unmatched) a question no validation result carries an id for', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(2))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ id: 'q1', answer_valid: true, acceptable_variations: [], notes: 'OK' }],
        }),
      });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 2, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].id).toContain('q1');
    expect(result.stats.validation_unmatched).toBe(1);
    expect(result.stats.validation_errors).toBe(0);
    expect(result.stats.validation_rejected).toBe(0);
  });

  it('rejects the whole group as validation_errors when the response has no JSON object', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(2))
      .mockResolvedValueOnce({ text: 'not json at all' });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 2, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(0);
    expect(result.stats.validation_errors).toBe(2);
    expect(result.stats.validation_unmatched).toBe(0);
  });

  it('rejects the whole group as validation_errors when the results field is missing', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(2))
      .mockResolvedValueOnce({ text: JSON.stringify({ notResults: [] }) });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 2, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(0);
    expect(result.stats.validation_errors).toBe(2);
  });

  it('rejects the whole group as validation_errors when the validation call itself throws', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(2))
      .mockRejectedValueOnce(new Error('network blip'));

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 2, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(0);
    expect(result.stats.validation_errors).toBe(2);
  });

  it('still rejects a question the validator explicitly marks invalid, distinct from unmatched/errors', async () => {
    callLlmMock
      .mockResolvedValueOnce(generationResponse(1))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ id: 'q1', answer_valid: false, acceptable_variations: [], notes: 'Wrong answer' }],
        }),
      });

    const result = await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 1, UNITS, 'batch-1');

    expect(result.questions).toHaveLength(0);
    expect(result.stats.validation_rejected).toBe(1);
    expect(result.stats.validation_unmatched).toBe(0);
    expect(result.stats.validation_errors).toBe(0);
  });
});
