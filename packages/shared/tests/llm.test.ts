import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLlm, LlmError, responseMetaFromLlmResult } from '../src/llm';
import { MODELS } from '../src/models';

/** Minimal Response-shaped mock. Only the members callLlm actually reads. */
function mockResponse(overrides: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
}) {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    statusText: overrides.statusText ?? 'OK',
    json: overrides.json ?? (() => Promise.resolve({})),
  };
}

function okBody(content: string | null | undefined, model = 'anthropic/claude-sonnet-4.5') {
  return {
    model,
    choices: [{ message: { content } }],
  };
}

describe('callLlm', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('maps choices[0].message.content to result.text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('hello world', 'anthropic/claude-sonnet-4.5')) })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.text).toBe('hello world');
    expect(result.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('sets response_format when jsonMode is true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('{}')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      jsonMode: true,
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('omits response_format when jsonMode is false or unset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('response_format');
  });

  it('passes temperature through unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.1,
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.1);
  });

  it('omits temperature when not provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('temperature');
  });

  it('omits max_tokens when not provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'mistralai/mistral-large',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('passes max_tokens through unchanged when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2000,
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(2000);
  });

  it('pins provider via providerOnly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'mistralai/mistral-large',
      messages: [{ role: 'user', content: 'hi' }],
      providerOnly: 'Mistral',
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ order: ['Mistral'], allow_fallbacks: false });
  });

  it('omits provider when providerOnly is not set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('provider');
  });

  it('sends session_id when sessionId is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: 'run-123:generation',
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.session_id).toBe('run-123:generation');
  });

  it('omits session_id when sessionId is not set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('session_id');
  });

  it('throws LlmError on non-2xx with the upstream error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { message: 'rate limited' } }),
      })
    );

    let caught: unknown;
    try {
      await callLlm({
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).status).toBe(429);
    expect((caught as LlmError).message).toContain('rate limited');
  });

  it('throws LlmError when message content is structurally missing, independent of jsonMode', async () => {
    const emptyChoices = () =>
      vi.fn().mockResolvedValue(mockResponse({ json: () => Promise.resolve({ choices: [] }) }));
    const nullContent = () =>
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ json: () => Promise.resolve({ choices: [{ message: { content: null } }] }) })
        );

    await expect(
      callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: emptyChoices() })
    ).rejects.toBeInstanceOf(LlmError);

    await expect(
      callLlm({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        jsonMode: true,
        fetchImpl: emptyChoices(),
      })
    ).rejects.toBeInstanceOf(LlmError);

    await expect(
      callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl: nullContent() })
    ).rejects.toBeInstanceOf(LlmError);

    await expect(
      callLlm({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        jsonMode: true,
        fetchImpl: nullContent(),
      })
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('throws LlmError for empty content only when jsonMode is set', async () => {
    const emptyContentFetch = () =>
      vi
        .fn()
        .mockResolvedValue(
          mockResponse({ json: () => Promise.resolve({ choices: [{ message: { content: '' } }] }) })
        );

    await expect(
      callLlm({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        jsonMode: true,
        fetchImpl: emptyContentFetch(),
      })
    ).rejects.toBeInstanceOf(LlmError);

    const result = await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl: emptyContentFetch(),
    });
    expect(result.text).toBe('');
  });

  it('sends Authorization header built from OPENROUTER_API_KEY', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-abc123';
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer sk-or-abc123');
  });

  it('throws before making a network call when OPENROUTER_API_KEY is unset', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchImpl = vi.fn();

    await expect(
      callLlm({
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(LlmError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to statusText when the error body isn't valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('not json')),
      })
    );

    let caught: unknown;
    try {
      await callLlm({
        model: 'anthropic/claude-sonnet-4.5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    expect((caught as LlmError).status).toBe(500);
    expect((caught as LlmError).message).toContain('Internal Server Error');
  });

  it('propagates a raw parse error, not an LlmError, when a 200 response body is not valid JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.reject(new SyntaxError('Unexpected token in JSON')) })
    );

    let caught: unknown;
    try {
      await callLlm({
        model: 'anthropic/claude-sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
      });
    } catch (err) {
      caught = err;
    }

    // Only the non-2xx branch catches a JSON-parse failure and falls back to statusText; a 200
    // response with an unparseable body (e.g. an HTML error page from an intermediary) is not
    // caught here, so it surfaces as the raw SyntaxError rather than a structured LlmError. This
    // test documents that current behavior rather than asserting it is correct.
    expect(caught).toBeInstanceOf(SyntaxError);
    expect(caught).not.toBeInstanceOf(LlmError);
  });
});

describe('callLlm reasoning control', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('sends reasoning: { enabled: false } only when disableReasoning is set', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ json: () => Promise.resolve(okBody('ok')) }));

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      disableReasoning: true,
      fetchImpl,
    });
    const withFlag = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(withFlag.reasoning).toEqual({ enabled: false });

    await callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
    const withoutFlag = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(withoutFlag).not.toHaveProperty('reasoning');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('names finish_reason and reasoning token usage when content is missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: null }, finish_reason: 'length' }],
            usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3998 } },
          }),
      })
    );

    await expect(
      callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl })
    ).rejects.toThrow(/finish_reason=length.*reasoning_tokens=3998\/4000/);
  });

  it('surfaces a provider error delivered inside a 200 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            choices: [
              { message: { content: null }, finish_reason: 'error', error: { message: 'upstream timeout' } },
            ],
          }),
      })
    );

    await expect(
      callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl })
    ).rejects.toThrow(/provider error: upstream timeout/);
  });
});

describe('callLlm reasoning option', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('sends only the fields set on reasoning', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { effort: 'low' },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('sends both enabled and effort when both are set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning: { enabled: true, effort: 'high' },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ enabled: true, effort: 'high' });
  });

  it('takes precedence over disableReasoning when both are set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      disableReasoning: true,
      reasoning: { effort: 'minimal' },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('omits reasoning when neither reasoning nor disableReasoning is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('reasoning');
  });
});

describe('callLlm provider option', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('sends only the fields set on provider', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { only: ['Nebius'] },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ only: ['Nebius'] });
  });

  it('sends order, only, and allow_fallbacks together when all are set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { order: ['Mistral'], only: ['Mistral'], allowFallbacks: false },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ order: ['Mistral'], only: ['Mistral'], allow_fallbacks: false });
  });

  it('takes precedence over providerOnly when both are set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      providerOnly: 'Anthropic',
      provider: { order: ['Mistral'] },
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.provider).toEqual({ order: ['Mistral'] });
  });

  it('omits provider when neither provider nor providerOnly is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('ok')) })
    );

    await callLlm({ model: 'm', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('provider');
  });
});

describe('callLlm multimodal content', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('serializes string content unchanged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'plain string content' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe('plain string content');
  });

  it('serializes an array of content parts (text + image_url)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'transcribe this page' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
          ],
        },
      ],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'transcribe this page' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });
});

describe('callLlm usage capture', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  it('parses usage and servedModel when OpenRouter returns them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            model: 'anthropic/claude-sonnet-5',
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              completion_tokens_details: { reasoning_tokens: 10 },
              cost: 0.0042,
              cost_details: { upstream_inference_cost: 0.003 },
              is_byok: true,
            },
          }),
      })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.servedModel).toBe('anthropic/claude-sonnet-5');
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      reasoningTokens: 10,
      costUsd: 0.0072,
      openrouterCostUsd: 0.0042,
      upstreamCostUsd: 0.003,
      isByok: true,
    });
  });

  it('parses servedProvider from the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            model: 'anthropic/claude-sonnet-5',
            provider: 'Anthropic',
            choices: [{ message: { content: 'ok' } }],
          }),
      })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.servedProvider).toBe('Anthropic');
  });

  it('leaves servedProvider undefined when OpenRouter omits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.servedProvider).toBeUndefined();
  });

  it('passes servedProvider through as null when OpenRouter sends provider: null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            model: 'anthropic/claude-sonnet-5',
            provider: null,
            choices: [{ message: { content: 'ok' } }],
          }),
      })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.servedProvider).toBeNull();
  });

  it('passes servedProvider through unvalidated when OpenRouter sends a non-string value', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            model: 'anthropic/claude-sonnet-5',
            provider: 42,
            choices: [{ message: { content: 'ok' } }],
          }),
      })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    // callLlm does not validate the shape of json.provider — it is assigned verbatim. This test
    // locks in that current behavior rather than an assumption; a caller that treats servedProvider
    // as always-a-string-or-undefined would mishandle this response.
    expect(result.servedProvider as unknown).toBe(42);
  });

  it('does not add the upstream figure on a credits call, where it repeats cost', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        json: () =>
          Promise.resolve({
            model: 'anthropic/claude-opus-5.5',
            choices: [{ message: { content: 'ok' } }],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              cost: 0.0014,
              cost_details: { upstream_inference_cost: 0.0014 },
              is_byok: false,
            },
          }),
      })
    );

    const result = await callLlm({
      model: 'anthropic/claude-opus-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.usage?.costUsd).toBe(0.0014);
    expect(result.usage?.openrouterCostUsd).toBe(0.0014);
    expect(result.usage?.upstreamCostUsd).toBe(0.0014);
    expect(result.usage?.isByok).toBe(false);
  });

  it('leaves usage and servedModel undefined when OpenRouter omits them', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) })
    );

    const result = await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    expect(result.usage).toBeUndefined();
    expect(result.servedModel).toBeUndefined();
    expect(result.model).toBe('anthropic/claude-sonnet-5');
  });

  it('never sends the deprecated usage.include request flag', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({ json: () => Promise.resolve(okBody('text')) })
    );

    await callLlm({
      model: 'anthropic/claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('usage');
  });
});

describe('responseMetaFromLlmResult', () => {
  it('picks id, created, per-choice finish reasons, cached tokens, and upstream cost by name', () => {
    const raw = {
      id: 'gen-abc123',
      created: 1735000000,
      model: 'anthropic/claude-sonnet-5',
      provider: 'Anthropic',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop', native_finish_reason: 'end_turn' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 10 },
        prompt_tokens_details: { cached_tokens: 40 },
        cost: 0.0042,
        cost_details: { upstream_inference_cost: 0.003 },
        is_byok: true,
      },
    };

    expect(responseMetaFromLlmResult({ raw })).toEqual({
      id: 'gen-abc123',
      created: 1735000000,
      choices: [{ finish_reason: 'stop', native_finish_reason: 'end_turn' }],
      usage: {
        prompt_tokens_details: { cached_tokens: 40 },
        cost_details: { upstream_inference_cost: 0.003 },
      },
    });
  });

  it('never carries message content, however it is nested in the raw response', () => {
    const sentinel = 'SENTINEL-DO-NOT-STORE-abc123';
    const raw = {
      id: 'gen-1',
      created: 1735000000,
      choices: [{ message: { content: sentinel }, finish_reason: 'stop', native_finish_reason: 'end_turn' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost_details: { upstream_inference_cost: 0.001 } },
    };

    const meta = responseMetaFromLlmResult({ raw });
    expect(JSON.stringify(meta)).not.toContain(sentinel);
  });

  it('returns undefined when raw carries none of the named fields', () => {
    expect(responseMetaFromLlmResult({ raw: {} })).toBeUndefined();
  });

  it('returns undefined when raw is absent', () => {
    expect(responseMetaFromLlmResult({ raw: undefined })).toBeUndefined();
  });

  it('omits usage and choices when neither carries a field it reads', () => {
    const raw = { id: 'gen-1', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10 } };
    expect(responseMetaFromLlmResult({ raw })).toEqual({ id: 'gen-1', choices: [{ finish_reason: 'stop' }] });
  });
});

describe('MODELS', () => {
  it('resolves the verified OpenRouter slug for every pipeline stage', () => {
    expect(MODELS.pdfConversion).toBe('anthropic/claude-sonnet-5');
    expect(MODELS.topicExtraction).toBe('anthropic/claude-sonnet-5');
    expect(MODELS.topicSimilarity).toBe('anthropic/claude-haiku-4.5');
    expect(MODELS.questionGenerationStructured).toBe('anthropic/claude-haiku-4.5');
    expect(MODELS.questionGenerationTyped).toBe('anthropic/claude-sonnet-5');
    expect(MODELS.answerValidation).toBe('anthropic/claude-sonnet-5');
    expect(MODELS.mistralAudit).toBe('mistralai/mistral-large-2512');
    expect(MODELS.mistralAuditBatch).toBe('mistralai/mistral-large-2512');
    expect(MODELS.sonnetAudit).toBe('anthropic/claude-sonnet-5');
    expect(MODELS.writingEvaluation).toBe('anthropic/claude-opus-5.5');
  });
});
