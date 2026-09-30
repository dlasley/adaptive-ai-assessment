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
 * `extractTopicContent` (real, unmocked — only the filesystem read in `loadUnitMaterials` is
 * stubbed) genuinely resolves against SAMPLE_MD, so a topic whose stored heading isn't in that
 * document produces the real empty-content result. This is the "no-content skip" path: no model
 * call, no questions, rather than falling back to ungrounded generation.
 */
describe('generateQuestionsForTopic — no-content skip', () => {
  it('skips generation and returns no questions when the topic resolves to no content', async () => {
    const units = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Ghost Topic', headings: ['Nonexistent Heading'] }] }];

    const result = await generateQuestionsForTopic('unit-1', 'Ghost Topic', 'beginner', 5, units, 'batch-1');

    expect(result.questions).toEqual([]);
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('proceeds to generation when the topic does resolve to content', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: JSON.stringify({ questions: [] }),
    });

    const units = [{ id: 'unit-1', source_file_stem: null, topics: [{ name: 'Real Topic', headings: ['Real Heading'] }] }];

    await generateQuestionsForTopic('unit-1', 'Real Topic', 'beginner', 5, units, 'batch-1');

    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });
});
