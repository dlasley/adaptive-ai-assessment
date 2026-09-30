import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRequestKnobs, LlmError, LlmNetworkError } from '@adaptive/shared/llm';
import {
  BatchRequestSpec,
  getBatchStatus,
  pollUntilDone,
  submitBatch,
  validateBatchRequest,
} from '../src/lib/llm-batch';

/** Minimal Response-shaped mock, matching tests/llm.test.ts's pattern. */
function mockResponse(overrides: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 202,
    statusText: overrides.statusText ?? 'Accepted',
    json: overrides.json ?? (() => Promise.resolve({})),
  };
}

function mockBatchObject(overrides: {
  id?: string;
  status?: string;
  request_counts?: { total: number; completed: number; failed: number };
  results?: unknown[] | null;
  error?: { message?: string } | null;
} = {}) {
  return {
    id: 'batch-1',
    status: 'validating',
    request_counts: { total: 1, completed: 0, failed: 0 },
    results: null,
    error: null,
    ...overrides,
  };
}

function oneSpec(overrides: Partial<BatchRequestSpec> = {}): BatchRequestSpec {
  return {
    customId: 'a',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('submitBatch', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('serializes endpoint, model, provider, completion_window before requests', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({
      model: 'mistralai/mistral-large-2512',
      requests: [oneSpec()],
      providerOnly: 'Mistral',
      fetchImpl,
    });

    const rawBody = fetchImpl.mock.calls[0][1].body as string;
    const endpointIdx = rawBody.indexOf('"endpoint"');
    const modelIdx = rawBody.indexOf('"model"');
    const providerIdx = rawBody.indexOf('"provider"');
    const windowIdx = rawBody.indexOf('"completion_window"');
    const requestsIdx = rawBody.indexOf('"requests"');

    expect(endpointIdx).toBeGreaterThanOrEqual(0);
    expect(endpointIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(providerIdx);
    expect(providerIdx).toBeLessThan(windowIdx);
    expect(windowIdx).toBeLessThan(requestsIdx);
  });

  it('appends :batch to the model slug', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({
      model: 'mistralai/mistral-large-2512',
      requests: [oneSpec()],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe('mistralai/mistral-large-2512:batch');
  });

  it('omits provider when providerOnly is not set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({ model: 'm', requests: [oneSpec()], fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('provider');
  });

  it('sets provider.only (not order/sort) when providerOnly is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({ model: 'm', requests: [oneSpec()], providerOnly: 'Mistral', fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ only: ['Mistral'] });
    expect(body.provider).not.toHaveProperty('order');
    expect(body.provider).not.toHaveProperty('sort');
  });

  it('builds one request per BatchRequestSpec, each with its custom_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({
      model: 'm',
      requests: [oneSpec({ customId: 'x' }), oneSpec({ customId: 'y' }), oneSpec({ customId: 'z' })],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.requests).toHaveLength(3);
    expect(body.requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(['x', 'y', 'z']);
  });

  it('never sets a per-request model field', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );

    await submitBatch({ model: 'm', requests: [oneSpec()], fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.requests[0].body).not.toHaveProperty('model');
  });

  it('reuses buildRequestKnobs for per-request temperature/maxTokens/jsonMode/disableReasoning', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(mockBatchObject()) })
    );
    const spec = oneSpec({ temperature: 0.7, jsonMode: true });

    await submitBatch({ model: 'm', requests: [spec], fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.requests[0].body).toEqual({
      messages: spec.messages,
      ...buildRequestKnobs(spec),
    });
  });

  it('rejects the whole call locally when a request spec fails pre-submit validation', async () => {
    const fetchImpl = vi.fn();
    const requests: BatchRequestSpec[] = [oneSpec({ customId: 'good' }), oneSpec({ customId: 'bad', messages: [] })];

    let caught: unknown;
    try {
      await submitBatch({ model: 'm', requests, fetchImpl });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).message).toContain('bad');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists every offending customId when multiple specs are invalid, not just the first', async () => {
    const fetchImpl = vi.fn();
    const requests: BatchRequestSpec[] = [
      oneSpec({ customId: 'bad-1', messages: [] }),
      oneSpec({ customId: 'bad-2', maxTokens: 0 }),
    ];

    let caught: unknown;
    try {
      await submitBatch({ model: 'm', requests, fetchImpl });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).message).toContain('bad-1');
    expect((caught as LlmError).message).toContain('bad-2');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws LlmError on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { message: 'rate limited' } }) })
    );

    let caught: unknown;
    try {
      await submitBatch({ model: 'm', requests: [oneSpec()], fetchImpl });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).status).toBe(429);
  });
});

describe('getBatchStatus', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('maps a validating/in_progress/finalizing/completed response to the typed status', async () => {
    for (const status of ['validating', 'in_progress', 'finalizing']) {
      const fetchImpl = vi.fn().mockResolvedValue(
        mockResponse({ status: 200, json: () => Promise.resolve(mockBatchObject({ status })) })
      );
      const result = await getBatchStatus('batch-1', fetchImpl);
      expect(result.status).toBe(status);
      expect(result.results).toBeNull();
    }

    const completedFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () =>
          Promise.resolve(
            mockBatchObject({
              status: 'completed',
              request_counts: { total: 1, completed: 1, failed: 0 },
              results: [{ custom_id: 'a', response: { status_code: 200, body: {} } }],
            })
          ),
      })
    );
    const completedResult = await getBatchStatus('batch-1', completedFetch);
    expect(completedResult.status).toBe('completed');
    expect(completedResult.results).not.toBeNull();
  });

  it("maps a completed batch's results, preserving exactly one of response/error per item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () =>
          Promise.resolve(
            mockBatchObject({
              status: 'completed',
              request_counts: { total: 2, completed: 1, failed: 1 },
              results: [
                { custom_id: 'ok-1', response: { status_code: 200, body: { choices: [] } } },
                { custom_id: 'err-1', error: { message: 'rejected' } },
              ],
            })
          ),
      })
    );

    const result = await getBatchStatus('batch-1', fetchImpl);

    expect(result.batchError).toBeNull();
    expect(result.results).toHaveLength(2);
    const [okItem, errItem] = result.results!;
    expect(okItem.customId).toBe('ok-1');
    expect(okItem.response).toEqual({ statusCode: 200, body: { choices: [] } });
    expect(okItem.error).toBeUndefined();
    expect(errItem.customId).toBe('err-1');
    expect(errItem.error).toEqual({ message: 'rejected' });
    expect(errItem.response).toBeUndefined();
  });

  it('surfaces a whole-batch pre-execution failure as batchError, distinctly from a per-request error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () =>
          Promise.resolve(
            mockBatchObject({
              status: 'failed',
              request_counts: { total: 5, completed: 0, failed: 0 },
              results: null,
              error: { message: 'request 3 failed validation: empty messages' },
            })
          ),
      })
    );

    const result = await getBatchStatus('batch-1', fetchImpl);

    expect(result.results).toBeNull();
    expect(result.batchError).toEqual({
      message: 'request 3 failed validation: empty messages',
      raw: { message: 'request 3 failed validation: empty messages' },
    });
  });

  it('throws LlmError on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 404, statusText: 'Not Found', json: () => Promise.resolve({}) })
    );

    await expect(getBatchStatus('missing', fetchImpl)).rejects.toBeInstanceOf(LlmError);
  });
});

describe('pollUntilDone', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    vi.useRealTimers();
  });

  it('returns completed as soon as status is completed, with no delay before resolving', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () =>
          Promise.resolve(
            mockBatchObject({
              status: 'completed',
              request_counts: { total: 1, completed: 1, failed: 0 },
              results: [{ custom_id: 'a', response: { status_code: 200, body: {} } }],
            })
          ),
      })
    );

    const outcome = await pollUntilDone({ batchId: 'b1', maxWaitMs: 60_000, pollIntervalMs: 1000, fetchImpl });

    expect(outcome.outcome).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns 'still_running' once maxWaitMs elapses without reaching a terminal status", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, json: () => Promise.resolve(mockBatchObject({ status: 'in_progress' })) })
    );

    const promise = pollUntilDone({ batchId: 'b1', maxWaitMs: 5000, pollIntervalMs: 1000, fetchImpl });
    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await promise;

    expect(outcome.outcome).toBe('still_running');
  });

  it('returns the terminal outcome for failed/expired/cancelled without waiting for maxWaitMs', async () => {
    const failedFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () => Promise.resolve(mockBatchObject({ status: 'failed', results: null, error: null })),
      })
    );

    const outcome = await pollUntilDone({ batchId: 'b1', maxWaitMs: 60 * 60 * 1000, pollIntervalMs: 30_000, fetchImpl: failedFetch });

    expect(outcome.outcome).toBe('failed');
    expect(failedFetch).toHaveBeenCalledTimes(1);

    const wholeBatchFailureFetch = vi.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        json: () =>
          Promise.resolve(
            mockBatchObject({ status: 'failed', results: null, error: { message: 'malformed request' } })
          ),
      })
    );

    const wholeBatchOutcome = await pollUntilDone({
      batchId: 'b1',
      maxWaitMs: 60 * 60 * 1000,
      pollIntervalMs: 30_000,
      fetchImpl: wholeBatchFailureFetch,
    });

    expect(wholeBatchOutcome.outcome).toBe('failed');
    expect(wholeBatchOutcome.result.batchError).toEqual({
      message: 'malformed request',
      raw: { message: 'malformed request' },
    });
  });

  it('polls at pollIntervalMs, not faster', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ status: 200, json: () => Promise.resolve(mockBatchObject({ status: 'in_progress' })) })
    );

    const promise = pollUntilDone({
      batchId: 'b1',
      maxWaitMs: 60 * 60 * 1000,
      pollIntervalMs: 30_000,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await promise;

    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(119);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(121);
  });
});

describe('buildRequestKnobs (shared between callLlm and submitBatch)', () => {
  it('includes each knob only when defined/true, matching the pre-extraction inline logic', () => {
    expect(buildRequestKnobs({})).toEqual({});
    expect(buildRequestKnobs({ temperature: 0.2 })).toEqual({ temperature: 0.2 });
    expect(buildRequestKnobs({ maxTokens: 100 })).toEqual({ max_tokens: 100 });
    expect(buildRequestKnobs({ jsonMode: true })).toEqual({ response_format: { type: 'json_object' } });
    expect(buildRequestKnobs({ jsonMode: false })).toEqual({});
    expect(buildRequestKnobs({ disableReasoning: true })).toEqual({ reasoning: { enabled: false } });
    expect(buildRequestKnobs({ disableReasoning: false })).toEqual({});
  });
});

describe('validateBatchRequest', () => {
  const clean: BatchRequestSpec = {
    customId: 'req-1',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
    jsonMode: true,
    disableReasoning: true,
    temperature: 0.2,
  };

  it('accepts a spec that uses only supported fields', () => {
    expect(validateBatchRequest(clean)).toEqual([]);
  });

  it('rejects stream and any other field outside the supported set', () => {
    const spec = { ...clean, stream: true, top_p: 0.9 } as unknown as BatchRequestSpec;
    const violations = validateBatchRequest(spec);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/unsupported field\(s\): stream, top_p/);
  });

  it('reports every violation in one spec, not just the first', () => {
    const spec = { customId: 'req-2', messages: [], maxTokens: 0, stream: true } as unknown as BatchRequestSpec;
    expect(validateBatchRequest(spec)).toHaveLength(3);
  });
});

describe('network failures', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('getBatchStatus turns a transport failure into LlmNetworkError carrying the cause', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND openrouter.ai'), { code: 'ENOTFOUND' });
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));

    const error = await getBatchStatus('batch-1', fetchImpl as unknown as typeof fetch).catch((e) => e);

    expect(error).toBeInstanceOf(LlmNetworkError);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain('getaddrinfo ENOTFOUND openrouter.ai');
  });

  it('submitBatch turns a transport failure into LlmNetworkError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      submitBatch({
        model: 'mistralai/mistral-large-2512',
        requests: [{ customId: 'r1', messages: [{ role: 'user', content: 'hi' }] }],
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(LlmNetworkError);
  });
});
