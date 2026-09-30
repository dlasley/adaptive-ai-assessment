/**
 * Chat-completion helper for OpenRouter's OpenAI-compatible endpoint.
 *
 * Reads OPENROUTER_API_KEY from process.env — never import this from a
 * client component. It intentionally has no `import 'server-only'` guard:
 * that package throws outside webpack/turbopack's react-server condition,
 * which would break every apps/pipeline command (plain Node, no bundler)
 * that imports it.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** OpenAI-compatible multimodal content part, as OpenRouter accepts them. */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user';
  /** A plain string for text-only calls, or content parts for a multimodal (e.g. image + text) call. */
  content: string | LlmContentPart[];
}

export interface LlmCallOptions {
  /** OpenRouter model slug, e.g. 'anthropic/claude-sonnet-4.5'. */
  model: string;
  messages: LlmMessage[];
  /** Omitted entirely from the request body when undefined — provider default applies. */
  temperature?: number;
  /** Omitted entirely from the request body when undefined — provider default applies. */
  maxTokens?: number;
  /** Sets response_format: { type: 'json_object' } when true. */
  jsonMode?: boolean;
  /**
   * Sends reasoning: { enabled: false }. Models that reason by default spend completion
   * tokens on it, and a long reasoning pass can exhaust maxTokens before any visible content
   * is produced. Some models (Opus 5.5) reject the request when reasoning is disabled, so
   * this is opt-in per call site rather than the default. Superseded by `reasoning` when both
   * are set.
   */
  disableReasoning?: boolean;
  /**
   * Full control over OpenRouter's `reasoning` request field: `enabled` toggles it outright,
   * `effort` sets a reasoning budget tier. Takes precedence over `disableReasoning` when both
   * are set. Omitted entirely when undefined — provider default applies.
   */
  reasoning?: { enabled?: boolean; effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' };
  /**
   * Pins routing to a single upstream provider name (OpenRouter's `provider.order`,
   * with `allow_fallbacks: false`). Used to guarantee cross-provider independence for
   * calls where the identity of the serving vendor matters. Superseded by `provider` when
   * both are set.
   */
  providerOnly?: string;
  /**
   * Full control over OpenRouter's `provider` request field: `order` and `only` name upstream
   * providers, `allowFallbacks` maps to `allow_fallbacks`. Takes precedence over `providerOnly`
   * when both are set. Each field is included only when set — no defaults are assumed.
   */
  provider?: { order?: string[]; only?: string[]; allowFallbacks?: boolean };
  /**
   * Groups related requests under OpenRouter's sticky routing key: same-session requests
   * are routed to the same upstream provider (falling back normally if that provider
   * errors) and grouped together in OpenRouter's dashboard. Must never carry a student or
   * user identifier — it is visible in OpenRouter's UI and logs.
   */
  sessionId?: string;
  /** Injection point for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Token, cost and routing accounting for one call, parsed from OpenRouter's `usage` object. */
export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Total USD the call cost the account: OpenRouter's own charge plus, for a BYOK call only, what
   * the vendor billed through the caller's own key. This is the figure to report and sum. */
  costUsd?: number;
  /** The part of costUsd OpenRouter charged in credits (the whole amount for a non-BYOK call). */
  openrouterCostUsd?: number;
  /** The part of costUsd the upstream vendor billed through the caller's own key (BYOK calls only). */
  upstreamCostUsd?: number;
  /** Whether the call was routed through the caller's own vendor key rather than OpenRouter credits. */
  isByok?: boolean;
}

export interface LlmResult {
  /** choices[0].message.content */
  text: string;
  /** The model OpenRouter reports serving the request. */
  model: string;
  /** The model OpenRouter reports actually serving the request (`json.model`), undefined if absent. */
  servedModel?: string;
  /** The host OpenRouter reports actually serving the request (`json.provider`), undefined if absent. */
  servedProvider?: string;
  /** Token and cost accounting for the call, undefined if OpenRouter returned no `usage` object. */
  usage?: LlmUsage;
  /** Full parsed response body, for callers that need finish_reason, usage, etc. */
  raw: unknown;
}

export class LlmError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message);
    this.name = 'LlmError';
  }
}

/** The request never reached OpenRouter: DNS, connection, or TLS failure. Always transient. */
export class LlmNetworkError extends LlmError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LlmNetworkError';
  }
}

/** Wraps a fetch call so a transport failure surfaces as LlmNetworkError instead of a bare TypeError. */
export async function fetchOrNetworkError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    const detail = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    throw new LlmNetworkError(`network error reaching OpenRouter: ${detail}`, err);
  }
}

export interface LlmRequestKnobs {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  disableReasoning?: boolean;
  reasoning?: LlmCallOptions['reasoning'];
}

/** Builds the `reasoning` request field from `reasoning` (preferred) or `disableReasoning`
 * (legacy shorthand for `{ enabled: false }`), or omits it entirely when neither is set. */
function buildReasoningKnob(knobs: LlmRequestKnobs): Record<string, unknown> | undefined {
  if (knobs.reasoning !== undefined) {
    const reasoning: Record<string, unknown> = {};
    if (knobs.reasoning.enabled !== undefined) reasoning.enabled = knobs.reasoning.enabled;
    if (knobs.reasoning.effort !== undefined) reasoning.effort = knobs.reasoning.effort;
    return reasoning;
  }
  if (knobs.disableReasoning) {
    return { enabled: false };
  }
  return undefined;
}

/** The subset of the OpenRouter request body that's identical whether the call is sync or batched. */
export function buildRequestKnobs(knobs: LlmRequestKnobs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (knobs.temperature !== undefined) {
    body.temperature = knobs.temperature;
  }
  if (knobs.maxTokens !== undefined) {
    body.max_tokens = knobs.maxTokens;
  }
  if (knobs.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  const reasoning = buildReasoningKnob(knobs);
  if (reasoning !== undefined) {
    body.reasoning = reasoning;
  }
  return body;
}

/** Builds the `provider` request field from `provider` (preferred) or `providerOnly` (legacy
 * shorthand for pinning a single provider with fallbacks disabled), or omits it entirely when
 * neither is set. */
export function buildProviderKnob(options: Pick<LlmCallOptions, 'provider' | 'providerOnly'>): Record<string, unknown> | undefined {
  if (options.provider !== undefined) {
    const provider: Record<string, unknown> = {};
    if (options.provider.order !== undefined) provider.order = options.provider.order;
    if (options.provider.only !== undefined) provider.only = options.provider.only;
    if (options.provider.allowFallbacks !== undefined) provider.allow_fallbacks = options.provider.allowFallbacks;
    return provider;
  }
  if (options.providerOnly !== undefined) {
    return { order: [options.providerOnly], allow_fallbacks: false };
  }
  return undefined;
}

interface OpenRouterErrorBody {
  error?: {
    message?: string;
  };
}

/** Shape of one OpenRouter chat-completion response body — a sync call's response, and also what
 * each completed item in a batch result carries as its own `response.body` (see `llm-batch.ts`). */
export interface OpenRouterResponseBody {
  model?: string;
  /** The host OpenRouter actually routed this call to (e.g. 'Anthropic', 'Together'). */
  provider?: string;
  error?: { message?: string };
  choices?: Array<{
    message?: {
      content?: string | null;
    };
    finish_reason?: string | null;
    error?: { message?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
    cost_details?: { upstream_inference_cost?: number };
    is_byok?: boolean;
  };
}

/** Builds the `usage` field of an `LlmResult` from an OpenRouter response body, or undefined if
 * it carried none. Exported so batch-result handling (`mistral-audit.ts`) can parse a completed
 * batch item's response body the same way a sync call's response is parsed here. */
export function parseUsage(json: OpenRouterResponseBody): LlmUsage | undefined {
  const usage = json.usage;
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    // OpenRouter reports upstream_inference_cost for every call. On a BYOK call `cost` is
    // OpenRouter's own charge (often 0) and upstream is what the vendor billed through the
    // caller's key, so they add; on a credits call upstream repeats `cost` and must not be added.
    costUsd: usage.cost === undefined && usage.cost_details?.upstream_inference_cost === undefined
      ? undefined
      : (usage.cost ?? 0) + (usage.is_byok ? (usage.cost_details?.upstream_inference_cost ?? 0) : 0),
    openrouterCostUsd: usage.cost,
    upstreamCostUsd: usage.cost_details?.upstream_inference_cost,
    isByok: usage.is_byok,
  };
}

/**
 * Explains a 200 response that carried no message content. OpenRouter reports provider
 * failures inside the body (top-level or per-choice `error`), and a model that spends its
 * whole completion budget on reasoning returns finish_reason "length" with empty content.
 */
function describeMissingContent(json: OpenRouterResponseBody): string {
  const choice = json.choices?.[0];
  const parts: string[] = [];
  const providerError = json.error?.message ?? choice?.error?.message;
  if (providerError) parts.push(`provider error: ${providerError}`);
  if (choice?.finish_reason) parts.push(`finish_reason=${choice.finish_reason}`);
  const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens;
  const completion = json.usage?.completion_tokens;
  if (reasoning !== undefined && completion !== undefined) {
    parts.push(`reasoning_tokens=${reasoning}/${completion}`);
  }
  if (!json.choices?.length) parts.push('no choices');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export async function callLlm(options: LlmCallOptions): Promise<LlmResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new LlmError('OPENROUTER_API_KEY is not set');
  }

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    ...buildRequestKnobs(options),
  };
  const provider = buildProviderKnob(options);
  if (provider !== undefined) {
    body.provider = provider;
  }
  if (options.sessionId !== undefined) {
    body.session_id = options.sessionId;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let errorBody: OpenRouterErrorBody | undefined;
    try {
      errorBody = (await res.json()) as OpenRouterErrorBody;
    } catch {
      errorBody = undefined;
    }
    const message = errorBody?.error?.message ?? res.statusText;
    throw new LlmError(message, res.status, errorBody);
  }

  const json = (await res.json()) as OpenRouterResponseBody;
  const content = json.choices?.[0]?.message?.content;

  if (content === null || content === undefined) {
    throw new LlmError(`missing content in response${describeMissingContent(json)}`, res.status, json);
  }

  if (options.jsonMode && content.trim() === '') {
    throw new LlmError('empty content in JSON mode', res.status, json);
  }

  return {
    text: content,
    model: json.model ?? options.model,
    servedModel: json.model,
    servedProvider: json.provider,
    usage: parseUsage(json),
    raw: json,
  };
}
