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

/**
 * The generation prompt asks for "up to N" questions (see prompts/questions-generate.md) — a thin
 * topic returning fewer than requested is the expected outcome, not a failure to correct for. This
 * covers the two things that must NOT happen when that occurs: no retry call, and no truncation
 * (truncation only applies when the model returns MORE than requested).
 */
describe('generateQuestionsForTopic — fewer than requested', () => {
  it('accepts fewer questions than requested without retrying', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: JSON.stringify({
        questions: [
          {
            id: 'q1',
            question: 'Vrai ou Faux: le ciel est bleu.',
            type: 'true-false',
            options: ['Vrai', 'Faux'],
            correctAnswer: 'Vrai',
            explanation: 'The sky is blue.',
          },
        ],
      }),
    });

    const units = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Real Topic', headings: ['Real Heading'] }] }];

    const result = await generateQuestionsForTopic(
      'unit-1', 'Real Topic', 'beginner', 5, units, 'batch-1',
      undefined, undefined, undefined, undefined, /* skipValidation */ true,
    );

    expect(result.questions).toHaveLength(1);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  it('still truncates when the model returns more than requested', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: JSON.stringify({
        questions: [1, 2, 3].map((n) => ({
          id: `q${n}`,
          question: `Question ${n}?`,
          type: 'true-false',
          options: ['Vrai', 'Faux'],
          correctAnswer: 'Vrai',
          explanation: 'ok',
        })),
      }),
    });

    const units = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Real Topic', headings: ['Real Heading'] }] }];

    const result = await generateQuestionsForTopic(
      'unit-1', 'Real Topic', 'beginner', 2, units, 'batch-1',
      undefined, undefined, undefined, undefined, true,
    );

    expect(result.questions).toHaveLength(2);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });
});
