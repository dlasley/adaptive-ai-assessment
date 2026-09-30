import { describe, expect, it, vi } from 'vitest';

const { callLlmMock } = vi.hoisted(() => ({ callLlmMock: vi.fn() }));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

import { auditSonnetQuestion } from '../src/commands/questions-audit';
import type { QuestionRow } from '../src/lib/db-queries';

function makeQuestion(overrides: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'q-1',
    question: 'Comment dit-on "hello"?',
    correct_answer: 'bonjour',
    explanation: null,
    unit_id: 'introduction',
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
    generated_by: 'anthropic/claude-sonnet-5',
    quality_status: 'pending',
    audit_metadata: null,
    ...overrides,
  } as QuestionRow;
}

function okBody(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    answer_correct: true,
    grammar_correct: true,
    no_hallucination: true,
    question_coherent: true,
    notes: 'OK',
    ...overrides,
  });
}

describe('auditSonnetQuestion', () => {
  it('maps a well-formed response to a passing result', async () => {
    callLlmMock.mockResolvedValueOnce({ text: okBody(), model: 'anthropic/claude-sonnet-5', raw: {} });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.answer_correct).toBe(true);
    expect(result.notes).toBe('OK');
  });

  it('falls back to a PARSE_ERROR passthrough on malformed JSON', async () => {
    callLlmMock.mockResolvedValueOnce({ text: 'not json', model: 'anthropic/claude-sonnet-5', raw: {} });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.notes).toContain('PARSE_ERROR:');
    // Placeholder booleans on a PARSE_ERROR result never gate a write (isParseError in sonnet-audit.ts).
    expect(result.answer_correct).toBe(true);
  });

  it('falls back to a PARSE_ERROR passthrough when a gate criterion is missing, naming what was missing', async () => {
    const body = JSON.parse(okBody());
    delete body.no_hallucination;
    callLlmMock.mockResolvedValueOnce({ text: JSON.stringify(body), model: 'anthropic/claude-sonnet-5', raw: {} });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.notes).toContain('PARSE_ERROR:');
    expect(result.notes).toContain('no_hallucination');
  });

  it('treats a non-boolean gate criterion the same as a missing one', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: okBody({ question_coherent: 'yes' }),
      model: 'anthropic/claude-sonnet-5',
      raw: {},
    });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.notes).toContain('PARSE_ERROR:');
    expect(result.notes).toContain('question_coherent');
  });

  it('carries the call\'s usage and served model onto the result', async () => {
    callLlmMock.mockResolvedValueOnce({
      text: okBody(),
      model: 'anthropic/claude-sonnet-5',
      servedModel: 'anthropic/claude-sonnet-5',
      usage: { promptTokens: 120, completionTokens: 40, costUsd: 0.003 },
      raw: {},
    });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.served_model).toBe('anthropic/claude-sonnet-5');
    expect(result.usage).toEqual({ prompt_tokens: 120, completion_tokens: 40, reasoning_tokens: null, cost_usd: 0.003 });
  });

  it('leaves usage and served_model null when the call carried none', async () => {
    callLlmMock.mockResolvedValueOnce({ text: okBody(), model: 'anthropic/claude-sonnet-5', raw: {} });

    const result = await auditSonnetQuestion(makeQuestion(), [], 'run-1:audit');

    expect(result.usage).toBeNull();
    expect(result.served_model).toBeNull();
  });
});
