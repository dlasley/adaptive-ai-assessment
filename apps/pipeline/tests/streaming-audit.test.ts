import { describe, expect, it, vi } from 'vitest';
import { runStreamingAudit } from '../src/lib/streaming-audit';
import type { QuestionRow } from '../src/lib/db-queries';

function makeQuestions(ids: string[]): QuestionRow[] {
  return ids.map((id) => ({
    id,
    question: `Q ${id}`,
    correct_answer: 'a',
    explanation: null,
    unit_id: 'unit-1',
    topic: 'greetings',
    difficulty: 'beginner',
    type: 'fill-in-blank',
    options: null,
    acceptable_variations: null,
    writing_type: null,
    hints: null,
    has_complete_sentence_requirement: null,
    content_hash: null,
    batch_id: null,
    source_file: null,
    generated_by: null,
    quality_status: 'pending',
    audit_metadata: null,
  }));
}

interface FakeSummary {
  count: number;
}

const emptySummary: FakeSummary = { count: 0 };
const mergeSummaries = (a: FakeSummary, b: FakeSummary): FakeSummary => ({ count: a.count + b.count });

describe('runStreamingAudit', () => {
  it('applies each group exactly once, with that group\'s own results and questions', async () => {
    const questions = makeQuestions(['a', 'b', 'c', 'd', 'e']);
    const applyGroupFn = vi.fn().mockImplementation(async (groupResults: string[]) => ({ count: groupResults.length }));

    const { summary } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 2,
      emptySummary,
      mergeSummaries,
      auditGroupFn: async (group) => group.map((q) => `result-${q.id}`),
      applyGroupFn,
    });

    // 5 questions, group size 2 -> groups of [a,b], [c,d], [e] -> 3 groups, 3 apply calls.
    expect(applyGroupFn).toHaveBeenCalledTimes(3);
    expect(applyGroupFn).toHaveBeenNthCalledWith(1, ['result-a', 'result-b'], questions.slice(0, 2));
    expect(applyGroupFn).toHaveBeenNthCalledWith(2, ['result-c', 'result-d'], questions.slice(2, 4));
    expect(applyGroupFn).toHaveBeenNthCalledWith(3, ['result-e'], questions.slice(4, 5));
    expect(summary).toEqual({ count: 5 });
  });

  it('accumulates the returned summary as the sum of each group\'s own summary', async () => {
    const questions = makeQuestions(['a', 'b', 'c', 'd']);
    let call = 0;
    const applyGroupFn = vi.fn().mockImplementation(async () => ({ count: ++call }));

    const { summary } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 2,
      emptySummary,
      mergeSummaries,
      auditGroupFn: async (group) => group.map((q) => q.id),
      applyGroupFn,
    });

    // Two groups, applyGroupFn returns { count: 1 } then { count: 2 } -> merged total 3.
    expect(summary).toEqual({ count: 3 });
  });

  it('never calls applyGroupFn when it is omitted (dry run) and returns the empty summary', async () => {
    const questions = makeQuestions(['a', 'b']);

    const { summary, results } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 2,
      emptySummary,
      mergeSummaries,
      auditGroupFn: async (group) => group.map((q) => q.id),
    });

    expect(summary).toBe(emptySummary);
    expect(results).toEqual(['a', 'b']);
  });

  it('collects every group\'s results in order, across groups', async () => {
    const questions = makeQuestions(['a', 'b', 'c']);

    const { results } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 1,
      emptySummary,
      mergeSummaries,
      auditGroupFn: async (group) => group.map((q) => `r-${q.id}`),
    });

    expect(results).toEqual(['r-a', 'r-b', 'r-c']);
  });

  it('stops after finishing the in-flight group once shouldStop reports true, leaving later groups unprocessed', async () => {
    const questions = makeQuestions(['a', 'b', 'c', 'd']);
    const auditGroupFn = vi.fn().mockImplementation(async (group: QuestionRow[]) => group.map((q) => q.id));

    const { results, interrupted } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 1,
      emptySummary,
      mergeSummaries,
      auditGroupFn,
      shouldStop: () => true, // "SIGINT already received" — stop as soon as this group is checked
    });

    expect(interrupted).toBe(true);
    expect(auditGroupFn).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['a']);
  });

  it('reports interrupted: false when the run finishes all groups on its own', async () => {
    const questions = makeQuestions(['a', 'b']);

    const { interrupted } = await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 1,
      emptySummary,
      mergeSummaries,
      auditGroupFn: async (group) => group.map((q) => q.id),
      shouldStop: () => false,
    });

    expect(interrupted).toBe(false);
  });

  it('reports cumulative questions done per group, not per successful result, to onGroupDone', async () => {
    const questions = makeQuestions(['a', 'b', 'c', 'd']);
    const onGroupDone = vi.fn();

    await runStreamingAudit<string, FakeSummary>({
      questions,
      groupSize: 2,
      emptySummary,
      mergeSummaries,
      // Simulates a group where one question's individual call failed (fewer results than inputs).
      auditGroupFn: async (group) => (group === questions.slice(0, 2) ? ['only-one'] : group.map((q) => q.id)),
      onGroupDone,
    });

    expect(onGroupDone).toHaveBeenNthCalledWith(1, 2, 4);
    expect(onGroupDone).toHaveBeenNthCalledWith(2, 4, 4);
  });
});
