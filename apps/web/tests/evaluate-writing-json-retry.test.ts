import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { LlmError } from '@adaptive/shared/llm';

const { singleMock, fromMock, callLlmMock } = vi.hoisted(() => {
  const singleMock = vi.fn();
  const fromMock = vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ single: singleMock })) })) }));
  const callLlmMock = vi.fn();
  return { singleMock, fromMock, callLlmMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/student-api-guard', () => ({
  requireStudentSession: vi.fn().mockResolvedValue({ studyCodeId: 'study-id' }),
}));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

// The in-memory limiter would count every request in the file against one session.
vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 }),
  getClientIp: () => '203.0.113.9',
}));

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';

const { loadQuestionsByIdsMock } = vi.hoisted(() => ({
  loadQuestionsByIdsMock: vi.fn(),
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: loadQuestionsByIdsMock,
}));

import { POST } from '@/app/api/evaluate-writing/route';
import { FEATURES } from '@/lib/feature-flags';

const PROD_URL = 'french-1.vercel.app';

const VALID_RESPONSE = {
  isCorrect: true,
  score: 90,
  hasCorrectAccents: true,
  feedback: 'ok',
  corrections: {},
  confidenceScore: 95,
};

/** "Bonjuor" is a one-transposition typo, above the beginner fuzzy threshold, so with fuzzy logic
 * skipped it always falls through to the Tier 4 model call under test here. */
function typoRequest(): NextRequest {
  return new NextRequest('https://example.com/api/evaluate-writing', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${PROD_URL}` },
    body: JSON.stringify({
      questionId: QUESTION_ID,
      userAnswer: 'Bonjuor',
    }),
  });
}

const flags = FEATURES as { SKIP_FUZZY_LOGIC: boolean };
const original = flags.SKIP_FUZZY_LOGIC;

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  singleMock.mockReset();
  singleMock.mockResolvedValue({ data: { is_superuser: true }, error: null });
  loadQuestionsByIdsMock.mockReset();
  loadQuestionsByIdsMock.mockResolvedValue(
    new Map([
      [
        QUESTION_ID,
        {
          id: QUESTION_ID,
          question: 'Translate: hello',
          correctAnswer: 'Bonjour',
          difficulty: 'beginner',
          type: 'writing',
          writingType: 'translation',
          acceptableVariations: [],
          unitId: 'unit-1',
          topic: 'greetings',
        },
      ],
    ])
  );
  callLlmMock.mockReset();
  flags.SKIP_FUZZY_LOGIC = true;
});

afterEach(() => {
  flags.SKIP_FUZZY_LOGIC = original;
  vi.restoreAllMocks();
});

describe('Tier 4 grading — JSON mode, fence stripping, retry, and shape validation', () => {
  it('requests jsonMode on the grading call', async () => {
    callLlmMock.mockResolvedValue({ text: JSON.stringify(VALID_RESPONSE) });

    await POST(typoRequest());

    expect(callLlmMock).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: true }));
  });

  it('logs cost, served model, and token counts from the grading call', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock.mockResolvedValue({
      text: JSON.stringify(VALID_RESPONSE),
      servedModel: 'anthropic/claude-opus-5.5',
      usage: { promptTokens: 300, completionTokens: 80, costUsd: 0.006 },
    });

    await POST(typoRequest());

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).toMatchObject({
      cost_usd: 0.006,
      served_model: 'anthropic/claude-opus-5.5',
      prompt_tokens: 300,
      completion_tokens: 80,
    });
  });

  it('sums usage across both attempts when the first response fails to parse', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock
      .mockResolvedValueOnce({ text: 'not json', usage: { promptTokens: 300, completionTokens: 5, costUsd: 0.001 } })
      .mockResolvedValueOnce({
        text: JSON.stringify(VALID_RESPONSE),
        servedModel: 'anthropic/claude-opus-5.5',
        usage: { promptTokens: 300, completionTokens: 80, costUsd: 0.006 },
      });

    await POST(typoRequest());

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).toMatchObject({ cost_usd: 0.007, prompt_tokens: 600, completion_tokens: 85 });
  });

  it('never logs served_provider, and leaves the response body unchanged, when callLlm returns one', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock.mockResolvedValue({
      text: JSON.stringify(VALID_RESPONSE),
      servedModel: 'anthropic/claude-opus-5.5',
      servedProvider: 'Anthropic',
      usage: { promptTokens: 300, completionTokens: 80, costUsd: 0.006 },
    });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.score).toBe(90);

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).toMatchObject({ served_model: 'anthropic/claude-opus-5.5' });
    expect(outcomeLog?.[1]).not.toHaveProperty('served_provider');
  });

  it('omits usage fields entirely when the call carried no usage data', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock.mockResolvedValue({ text: JSON.stringify(VALID_RESPONSE) });

    await POST(typoRequest());

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).not.toHaveProperty('cost_usd');
    expect(outcomeLog?.[1]).not.toHaveProperty('served_model');
  });

  it('strips markdown code fences before parsing', async () => {
    callLlmMock.mockResolvedValue({ text: '```json\n' + JSON.stringify(VALID_RESPONSE) + '\n```' });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(body.isCorrect).toBe(true);
    expect(body.score).toBe(90);
  });

  it('retries once when the first response is not valid JSON, and succeeds on the second', async () => {
    callLlmMock
      .mockResolvedValueOnce({ text: 'not json at all' })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_RESPONSE) });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.isCorrect).toBe(true);
    expect(body.score).toBe(90);
  });

  it('retries once when the first response is missing a required field, and succeeds on the second', async () => {
    const { feedback: _feedback, ...missingFeedback } = VALID_RESPONSE;
    callLlmMock
      .mockResolvedValueOnce({ text: JSON.stringify(missingFeedback) })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_RESPONSE) });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.feedback).toBe('ok');
  });

  it('retries once when score is out of the 0-100 range', async () => {
    callLlmMock
      .mockResolvedValueOnce({ text: JSON.stringify({ ...VALID_RESPONSE, score: 150 }) })
      .mockResolvedValueOnce({ text: JSON.stringify(VALID_RESPONSE) });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.score).toBe(90);
  });

  it('falls back to the safe response and logs parse_failure after a second failure, without retrying a third time', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock.mockResolvedValue({ text: 'still not json' });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.isCorrect).toBe(false);
    expect(body.score).toBe(50);

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).toMatchObject({ parse_failure: true });
  });

  it('retries once after an empty-content error and succeeds, recording usage from the failed attempt too', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock
      .mockRejectedValueOnce(new LlmError('empty content in JSON mode', 200, {
        model: 'anthropic/claude-opus-5.5',
        usage: { prompt_tokens: 900, completion_tokens: 1024, cost: 0.02 },
      }))
      .mockResolvedValueOnce({
        text: JSON.stringify(VALID_RESPONSE),
        servedModel: 'anthropic/claude-opus-5.5',
        usage: { promptTokens: 900, completionTokens: 300, costUsd: 0.008 },
      });

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.isCorrect).toBe(true);
    expect(body.score).toBe(90);

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    // Usage from the failed (billed) attempt is summed with the successful attempt's usage, and
    // the error flag records that some of it came from a call that errored.
    expect(outcomeLog?.[1]).toMatchObject({ cost_usd: 0.028, prompt_tokens: 1800, completion_tokens: 1324, error: true });
    expect(outcomeLog?.[1]).not.toHaveProperty('parse_failure');
  });

  it('falls back after two empty-content errors, with parse_failure and error usage both recorded', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock
      .mockRejectedValueOnce(new LlmError('empty content in JSON mode', 200, {
        model: 'anthropic/claude-opus-5.5',
        usage: { prompt_tokens: 900, completion_tokens: 1024, cost: 0.02 },
      }))
      .mockRejectedValueOnce(new LlmError('missing content in response (finish_reason=length)', 200, {
        model: 'anthropic/claude-opus-5.5',
        usage: { prompt_tokens: 900, completion_tokens: 1024, cost: 0.02 },
      }));

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(2);
    expect(body.isCorrect).toBe(false);
    expect(body.score).toBe(50);

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).toMatchObject({ parse_failure: true, cost_usd: 0.04, prompt_tokens: 1800, completion_tokens: 2048, error: true });
  });

  it('requests a 4096 token budget, not the old 1024, so reasoning + JSON output both fit', async () => {
    callLlmMock.mockResolvedValue({ text: JSON.stringify(VALID_RESPONSE) });

    await POST(typoRequest());

    expect(callLlmMock).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }));
  });

  it('does not retry a callLlm failure (network/auth/rate limit), and does not mark it a parse failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    callLlmMock.mockRejectedValue(new Error('rate limited'));

    const res = await POST(typoRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(body.isCorrect).toBe(false);
    expect(body.score).toBe(50);

    const outcomeLog = logSpy.mock.calls.find(([line]) => String(line).includes('Evaluation complete'));
    expect(outcomeLog?.[1]).not.toMatchObject({ parse_failure: true });
  });

  it('never logs the student answer, even on a parse failure', async () => {
    // Debug-level tracing (which does carry truncated student text) is silenced on any deployed
    // build — see src/lib/logger.ts. Stub that to isolate what THIS code path (warn/error/the
    // info-level outcome line) logs on a parse failure.
    vi.stubEnv('NODE_ENV', 'production');
    process.env.VERCEL_ENV = 'production';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    callLlmMock.mockResolvedValue({ text: 'not json at all, "Bonjuor" mentioned here' });

    await POST(typoRequest());

    const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((arg) => JSON.stringify(arg))
      .join('\n');

    expect(everythingLogged).not.toContain('Bonjuor');

    vi.unstubAllEnvs();
    delete process.env.VERCEL_ENV;
  });
});
