import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock('@/lib/supabase', () => ({
  supabase: { from: fromMock },
  isSupabaseAvailable: () => true,
}));

import { loadAllQuestions, loadQuestionsByIds } from '@/lib/question-loader';

const BASE_ROW = {
  id: 'q1',
  correct_answer: 'Bonjour',
  explanation: null,
  unit_id: 'unit-1',
  topic: 'greetings',
  difficulty: 'beginner',
  type: 'writing',
  options: null,
  acceptable_variations: [],
  writing_type: 'translation',
  hints: [],
  has_complete_sentence_requirement: false,
};

/** Wires `.from('questions').select('*').eq().order().range()` to resolve once with `rows`, then
 * an empty page — matching loadAllQuestions' pagination loop, which stops once a page comes back
 * shorter than PAGE_SIZE. */
function mockQuestionPool(rows: Record<string, unknown>[]): void {
  const rangeMock = vi.fn().mockResolvedValue({ data: rows, error: null });
  fromMock.mockReturnValue({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({ order: vi.fn(() => ({ range: rangeMock })) })),
    })),
  });
}

beforeEach(() => {
  fromMock.mockReset();
});

describe('isMetaQuestion filtering (via loadAllQuestions)', () => {
  it('does not drop a legitimate question that merely mentions "practice" or "consistency"', async () => {
    mockQuestionPool([
      { ...BASE_ROW, id: 'q-practice', question: 'Complete the sentence: "La pratique rend parfait." What does "pratique" mean?' },
      { ...BASE_ROW, id: 'q-consistency', question: 'Which verb form is used consistently across all "-er" verbs in the present tense?' },
    ]);

    const questions = await loadAllQuestions();

    expect(questions.map((q) => q.id)).toEqual(['q-practice', 'q-consistency']);
  });

  it('drops a generator-artifact meta-question and logs its id and the matched rule, never its text', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockQuestionPool([
      { ...BASE_ROW, id: 'q-meta', question: 'What is the most important factor in language learning success?' },
      { ...BASE_ROW, id: 'q-real', question: 'Conjugate "parler" in the present tense for "nous".' },
    ]);

    const questions = await loadAllQuestions();

    expect(questions.map((q) => q.id)).toEqual(['q-real']);

    const dropLog = logSpy.mock.calls.find(([line]) => String(line).includes('Dropped question'));
    expect(dropLog?.[1]).toEqual({ questionId: 'q-meta', rule: 'most-important-factor-for-success' });

    const everythingLogged = logSpy.mock.calls.flat().map((arg) => JSON.stringify(arg)).join('\n');
    expect(everythingLogged).not.toContain('most important factor in language learning success');

    logSpy.mockRestore();
  });
});

describe('loadQuestionsByIds', () => {
  it('returns a map keyed by id for every matching row, regardless of quality_status', async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [{ ...BASE_ROW, id: 'q1' }, { ...BASE_ROW, id: 'q2', correct_answer: 'Au revoir' }],
      error: null,
    });
    fromMock.mockReturnValue({ select: vi.fn(() => ({ in: inMock })) });

    const result = await loadQuestionsByIds(['q1', 'q2']);

    expect(inMock).toHaveBeenCalledWith('id', ['q1', 'q2']);
    expect(result.get('q1')?.correctAnswer).toBe('Bonjour');
    expect(result.get('q2')?.correctAnswer).toBe('Au revoir');
  });

  it('returns an empty map for an empty id list without querying the database', async () => {
    const result = await loadQuestionsByIds([]);

    expect(result.size).toBe(0);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('omits ids with no matching row rather than throwing', async () => {
    const inMock = vi.fn().mockResolvedValue({ data: [], error: null });
    fromMock.mockReturnValue({ select: vi.fn(() => ({ in: inMock })) });

    const result = await loadQuestionsByIds(['missing-id']);

    expect(result.size).toBe(0);
  });
});
