import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '@adaptive/shared/types';

vi.mock('@/lib/supabase', () => ({
  supabase: null,
  isSupabaseAvailable: () => false,
}));

import { selectQuestions } from '@/lib/question-loader';
import { QUIZ_MODES } from '@/lib/quiz-modes';

let nextId = 0;
function makeQuestion(overrides: Partial<Question> = {}): Question {
  nextId += 1;
  return {
    id: `q${nextId}`,
    question: `Question ${nextId}?`,
    type: 'multiple-choice',
    correctAnswer: 'A',
    unitId: 'unit-1',
    topic: 'greetings',
    difficulty: 'beginner',
    ...overrides,
  };
}

function makePool(counts: Partial<Record<Question['type'], number>>, overrides: Partial<Question> = {}): Question[] {
  return Object.entries(counts).flatMap(([type, count]) =>
    Array.from({ length: count }, () => makeQuestion({ type: type as Question['type'], ...overrides }))
  );
}

function countByType(questions: Question[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const q of questions) counts[q.type] = (counts[q.type] ?? 0) + 1;
  return counts;
}

/** The criteria the quiz route builds from a mode. */
function modeCriteria(mode: keyof typeof QUIZ_MODES) {
  const { allowedTypes, typeDistribution } = QUIZ_MODES[mode];
  return { allowedTypes, typeDistribution };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('selectQuestions with a mode distribution', () => {
  it('splits a practice quiz by the mode ratios when every type has enough questions', () => {
    const pool = makePool({ 'multiple-choice': 30, 'true-false': 30, 'fill-in-blank': 30, writing: 30 });

    const result = selectQuestions(pool, { numQuestions: 20, ...modeCriteria('practice') });

    expect(result.questions).toHaveLength(20);
    expect(countByType(result.questions)).toEqual({
      'multiple-choice': 7,
      'true-false': 3,
      'fill-in-blank': 4,
      writing: 6,
    });
    expect(result.warnings).toEqual([]);
    expect(result.requestedCount).toBe(20);
    expect(result.actualCount).toBe(20);
  });

  it('hands the leftover question to the first type with the largest fractional share', () => {
    const pool = makePool({ 'fill-in-blank': 10, writing: 10 });

    const result = selectQuestions(pool, { numQuestions: 5, ...modeCriteria('assessment') });

    expect(countByType(result.questions)).toEqual({ 'fill-in-blank': 3, writing: 2 });
  });

  it('never returns the same question twice', () => {
    const pool = makePool({ 'multiple-choice': 10, 'true-false': 10, 'fill-in-blank': 10, writing: 10 });

    const result = selectQuestions(pool, { numQuestions: 25, ...modeCriteria('practice') });

    expect(new Set(result.questions.map((q) => q.id)).size).toBe(result.questions.length);
  });

  it('excludes types the mode does not allow, even when they are plentiful', () => {
    const pool = makePool({ 'multiple-choice': 50, 'true-false': 50, 'fill-in-blank': 5, writing: 5 });

    const result = selectQuestions(pool, { numQuestions: 6, ...modeCriteria('assessment') });

    expect(result.questions.every((q) => q.type === 'fill-in-blank' || q.type === 'writing')).toBe(true);
  });

  it('warns and returns what exists when a type runs short and nothing else can fill the gap', () => {
    const pool = makePool({ 'fill-in-blank': 4, writing: 1 });

    const result = selectQuestions(pool, { numQuestions: 6, ...modeCriteria('assessment') });

    expect(result.actualCount).toBe(5);
    expect(result.requestedCount).toBe(6);
    expect(result.warnings).toContain('Only 1 writing questions available (wanted 3)');
    expect(result.warnings).toContain('Only 5 questions available (requested 6)');
  });

  it('fills a short type from the other allowed types', () => {
    const pool = makePool({ 'fill-in-blank': 10, writing: 1 });

    const result = selectQuestions(pool, { numQuestions: 6, ...modeCriteria('assessment') });

    expect(result.actualCount).toBe(6);
    expect(countByType(result.questions)).toEqual({ 'fill-in-blank': 5, writing: 1 });
    expect(result.warnings).toEqual(['Only 1 writing questions available (wanted 3)']);
  });

  it('returns an empty selection for an empty pool', () => {
    const result = selectQuestions([], { numQuestions: 5, ...modeCriteria('practice') });

    expect(result.questions).toEqual([]);
    expect(result.actualCount).toBe(0);
  });
});

describe('selectQuestions filters', () => {
  const base = { numQuestions: 10, ...modeCriteria('practice') };

  it("keeps a unit's questions plus those marked for every unit, and drops other units", () => {
    const own = makeQuestion({ unitId: 'unit-1' });
    const shared = makeQuestion({ unitId: 'all' });
    const other = makeQuestion({ unitId: 'unit-2' });

    const result = selectQuestions([own, shared, other], { ...base, unitId: 'unit-1' });

    expect(result.questions.map((q) => q.id).sort()).toEqual([own.id, shared.id].sort());
  });

  it("does not filter by unit when the unit is 'all'", () => {
    const pool = [makeQuestion({ unitId: 'unit-1' }), makeQuestion({ unitId: 'unit-2' })];

    expect(selectQuestions(pool, { ...base, unitId: 'all' }).questions).toHaveLength(2);
  });

  it('matches a topic regardless of case', () => {
    const match = makeQuestion({ topic: 'Les Fruits' });
    const miss = makeQuestion({ topic: 'greetings' });

    const result = selectQuestions([match, miss], { ...base, topic: 'les fruits' });

    expect(result.questions.map((q) => q.id)).toEqual([match.id]);
  });

  it('matches difficulty exactly', () => {
    const match = makeQuestion({ difficulty: 'advanced' });
    const miss = makeQuestion({ difficulty: 'beginner' });

    const result = selectQuestions([match, miss], { ...base, difficulty: 'advanced' });

    expect(result.questions.map((q) => q.id)).toEqual([match.id]);
  });

  it('applies unit, topic and difficulty together', () => {
    const match = makeQuestion({ unitId: 'unit-1', topic: 'greetings', difficulty: 'beginner' });
    const wrongTopic = makeQuestion({ unitId: 'unit-1', topic: 'food', difficulty: 'beginner' });
    const wrongDifficulty = makeQuestion({ unitId: 'unit-1', topic: 'greetings', difficulty: 'advanced' });

    const result = selectQuestions([match, wrongTopic, wrongDifficulty], {
      ...base,
      unitId: 'unit-1',
      topic: 'greetings',
      difficulty: 'beginner',
    });

    expect(result.questions.map((q) => q.id)).toEqual([match.id]);
  });
});

describe('selectQuestions with Leitner weights', () => {
  const lowWeight = makeQuestion({ type: 'writing' });
  const highWeight = makeQuestion({ type: 'writing' });
  // Box 5 weighs 1 and box 1 weighs 5, so the cumulative range splits at 1/6.
  const leitnerWeights = new Map([[lowWeight.id, 5], [highWeight.id, 1]]);
  const criteria = { numQuestions: 1, allowedTypes: ['writing' as const], typeDistribution: { writing: 1 }, leitnerWeights };

  it('picks the higher-weight question when the random draw lands in its range', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(selectQuestions([lowWeight, highWeight], criteria).questions).toEqual([highWeight]);
  });

  it('picks the lower-weight question when the random draw lands in its range', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.05);

    expect(selectQuestions([lowWeight, highWeight], criteria).questions).toEqual([lowWeight]);
  });
});
