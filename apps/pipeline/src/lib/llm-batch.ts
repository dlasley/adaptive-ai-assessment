/**
 * OpenRouter batch API primitives: submit, poll, and collect protocol handling.
 *
 * Stops at protocol primitives — this module doesn't know about questions, topics, or
 * audit criteria, mirroring how `callLlm` doesn't parse response JSON into domain types.
 */

import {
  LlmError,
  LlmMessage,
  LlmRequestKnobs,
  buildRequestKnobs,
  fetchOrNetworkError,
} from '@adaptive/shared/llm';
import { sleep } from './sleep';

const OPENROUTER_BATCH_URL = 'https://openrouter.ai/api/v1/batches';

type BatchStatus =
  | 'validating'
  | 'in_progress'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

const TERMINAL_STATUSES: readonly BatchStatus[] = ['failed', 'expired', 'cancelled'];

export interface BatchRequestSpec extends LlmRequestKnobs {
  /** Caller-assigned, unique within this batch. Echoed back on the matching result. */
  customId: string;
  messages: LlmMessage[];
}

export interface SubmitBatchOptions {
  /** Sync-style OpenRouter model slug, e.g. 'mistralai/mistral-large-2512'. The ':batch' suffix is
   *  appended by submitBatch. Per-request bodies never repeat this field — every request in a batch
   *  inherits the batch-level model. */
  model: string;
  requests: BatchRequestSpec[];
  /** Batch-level provider pin (OpenRouter's `provider.only`). Used only by the Mistral audit. */
  providerOnly?: string;
  fetchImpl?: typeof fetch;
}

const ALLOWED_SPEC_KEYS: ReadonlySet<string> = new Set([
  'customId',
  'messages',
  'temperature',
  'maxTokens',
  'jsonMode',
  'disableReasoning',
] satisfies (keyof BatchRequestSpec)[]);

/**
 * Cheap, local, no-network checks that catch the mundane causes of a whole-batch pre-execution
 * rejection before a single API call is made. Returns one violation string per problem found,
 * or an empty array if the spec is clean. submitBatch calls this on every spec in `requests` and
 * throws (without touching the network) if any spec has a violation.
 */
export function validateBatchRequest(spec: BatchRequestSpec): string[] {
  const violations: string[] = [];
  // Untyped callers can still pass extra fields; `stream` in particular fails the whole batch.
  const unexpected = Object.keys(spec).filter((key) => !ALLOWED_SPEC_KEYS.has(key));
  if (unexpected.length > 0) {
    violations.push(`unsupported field(s): ${unexpected.join(', ')}`);
  }
  if (!spec.messages || spec.messages.length === 0) {
    violations.push('messages must be non-empty');
  }
  if (spec.maxTokens !== undefined && spec.maxTokens < 1) {
    violations.push(`maxTokens must be >= 1, got ${spec.maxTokens}`);
  }
  return violations;
}

export interface RequestCounts {
  total: number;
  completed: number;
  failed: number;
}

export interface SubmitBatchResult {
  id: string;
  status: BatchStatus;
  requestCounts: RequestCounts;
}

export interface BatchResultItem {
  customId: string;
  response?: { statusCode: number; body: unknown };
  error?: { message: string; [key: string]: unknown };
}

export interface PollBatchResult {
  id: string;
  status: BatchStatus;
  requestCounts: RequestCounts;
  /** Populated only when status === 'completed'. */
  results: BatchResultItem[] | null;
  /**
   * Populated only when status === 'failed' AND the batch never reached `in_progress` — a
   * whole-batch pre-execution rejection (a malformed request among `requests`), not an ordinary
   * terminal failure after execution began. `results` is null in this case; OpenRouter's `error`
   * field, carried here verbatim, is the only diagnostic available.
   */
  batchError: { message: string; raw: unknown } | null;
}

interface OpenRouterBatchResultBody {
  custom_id: string;
  response?: { status_code: number; body: unknown };
  error?: { message: string; [key: string]: unknown };
}

interface OpenRouterBatchBody {
  id: string;
  status: BatchStatus;
  request_counts?: { total?: number; completed?: number; failed?: number };
  results?: OpenRouterBatchResultBody[] | null;
  error?: { message?: string; [key: string]: unknown } | null;
}

interface OpenRouterErrorBody {
  error?: { message?: string };
}

async function toLlmError(res: Response): Promise<LlmError> {
  let errorBody: OpenRouterErrorBody | undefined;
  try {
    errorBody = (await res.json()) as OpenRouterErrorBody;
  } catch {
    errorBody = undefined;
  }
  const message = errorBody?.error?.message ?? res.statusText;
  return new LlmError(message, res.status, errorBody);
}

function toRequestCounts(counts: OpenRouterBatchBody['request_counts']): RequestCounts {
  return {
    total: counts?.total ?? 0,
    completed: counts?.completed ?? 0,
    failed: counts?.failed ?? 0,
  };
}

function toResultItem(item: OpenRouterBatchResultBody): BatchResultItem {
  const result: BatchResultItem = { customId: item.custom_id };
  if (item.response !== undefined) {
    result.response = { statusCode: item.response.status_code, body: item.response.body };
  }
  if (item.error !== undefined) {
    result.error = item.error;
  }
  return result;
}

export async function submitBatch(options: SubmitBatchOptions): Promise<SubmitBatchResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new LlmError('OPENROUTER_API_KEY is not set');
  }

  const violations = options.requests.flatMap((spec) =>
    validateBatchRequest(spec).map((violation) => `${spec.customId}: ${violation}`)
  );
  if (violations.length > 0) {
    throw new LlmError(`invalid batch request spec(s): ${violations.join('; ')}`);
  }

  const body: Record<string, unknown> = {
    endpoint: '/v1/chat/completions',
    model: `${options.model}:batch`,
  };
  if (options.providerOnly !== undefined) {
    body.provider = { only: [options.providerOnly] };
  }
  body.completion_window = '24h';
  body.requests = options.requests.map((spec) => ({
    custom_id: spec.customId,
    body: {
      messages: spec.messages,
      ...buildRequestKnobs(spec),
    },
  }));

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchOrNetworkError(fetchImpl, OPENROUTER_BATCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw await toLlmError(res);
  }

  const json = (await res.json()) as OpenRouterBatchBody;
  return {
    id: json.id,
    status: json.status,
    requestCounts: toRequestCounts(json.request_counts),
  };
}

export async function getBatchStatus(
  batchId: string,
  fetchImpl: typeof fetch = fetch
): Promise<PollBatchResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new LlmError('OPENROUTER_API_KEY is not set');
  }

  const res = await fetchOrNetworkError(fetchImpl, `${OPENROUTER_BATCH_URL}/${batchId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw await toLlmError(res);
  }

  const json = (await res.json()) as OpenRouterBatchBody;
  const results = json.status === 'completed' && json.results ? json.results.map(toResultItem) : null;
  const batchError =
    json.status === 'failed' && json.results == null && json.error
      ? { message: json.error.message ?? 'batch failed pre-execution', raw: json.error }
      : null;

  return {
    id: json.id,
    status: json.status,
    requestCounts: toRequestCounts(json.request_counts),
    results,
    batchError,
  };
}

export interface PollUntilDoneOptions {
  batchId: string;
  /** Wall-clock budget for THIS call, not the batch's lifetime. Default 60 minutes. */
  maxWaitMs?: number;
  /** Default 30 seconds. */
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export type PollOutcome =
  | { outcome: 'completed'; result: PollBatchResult }
  | { outcome: 'still_running'; result: PollBatchResult }
  | { outcome: 'failed' | 'expired' | 'cancelled'; result: PollBatchResult };

export async function pollUntilDone(options: PollUntilDoneOptions): Promise<PollOutcome> {
  const maxWaitMs = options.maxWaitMs ?? 60 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const result = await getBatchStatus(options.batchId, options.fetchImpl);

    if (result.status === 'completed') {
      return { outcome: 'completed', result };
    }
    if (TERMINAL_STATUSES.includes(result.status)) {
      return { outcome: result.status as 'failed' | 'expired' | 'cancelled', result };
    }
    if (Date.now() >= deadline) {
      return { outcome: 'still_running', result };
    }
    await sleep(pollIntervalMs);
  }
}
