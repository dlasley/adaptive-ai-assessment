/**
 * Shared logic between questions-audit.ts's Mistral synchronous audit loop and its --llm-batch /
 * --llm-batch-resume state machine: prompt construction, result parsing, the llm_batch_jobs
 * bookkeeping store, and the quality_status/audit_metadata write-db logic. Kept separate from
 * the CLI script so both call paths reuse exactly the same parsing and DB-write code, and so
 * the batch state machine can be unit tested with injected dependencies instead of a live
 * OpenRouter batch and a live Supabase connection.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SupabaseClient } from '@supabase/supabase-js';
import { BatchRequestSpec, BatchResultItem, PollOutcome, RequestCounts } from './llm-batch';
import { callLlm, LlmError, LlmNetworkError, LlmUsage, parseUsage, responseMetaFromLlmResult, type LlmCallOptions, type OpenRouterResponseBody } from '@adaptive/shared/llm';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { isDifficulty } from '@adaptive/shared/enums';
import { AUDIT_GROUP_SIZE } from './pipeline-config';
import { buildAuditMaterialsBlock, type MaterialsUnit } from './learning-materials';
import { applyAuditWrites } from './audit-write';
import { chunk } from './array-utils';
import { createLogger } from './logger';
import { PROMPTS_DIR } from './paths';
import { emptyUsageTotals, type UsageTotals } from './usage-tracking';

const logger = createLogger('mistral-audit');

const JOBS_TABLE = 'llm_batch_jobs';

// Read lazily rather than at module scope: several tests mock 'fs' to control
// buildAuditMaterialsBlock's own reads (via learning-materials.ts) without expecting this module
// to make an unrelated read merely by being imported.
let rawMistralAuditPrompt: string | undefined;

function loadRawMistralAuditPrompt(): string {
  if (rawMistralAuditPrompt === undefined) {
    rawMistralAuditPrompt = readFileSync(join(PROMPTS_DIR, 'audit-mistral.md'), 'utf-8');
  }
  return rawMistralAuditPrompt;
}

/** The Mistral audit system prompt, with `{{COURSE_NAME}}`/`{{COURSE_LEVEL}}` substituted. Shared
 * by the sync path and the batch submit path, so both send the exact same system prompt. */
export function renderedMistralAuditSystemPrompt(): string {
  return renderCoursePrompt(loadRawMistralAuditPrompt());
}

export interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  writing_type: string | null;
  generated_by: string | null;
  options: string[] | null;
  acceptable_variations: string[] | null;
}

export interface MistralAuditResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  // Core 4 (shared with Sonnet audit)
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  // Mistral-specific
  natural_language: boolean;
  register_appropriate: boolean;
  difficulty_appropriate: boolean;
  suggested_difficulty: string | null;
  variations_valid: boolean;
  culturally_appropriate: boolean;
  missing_variations: string[];
  invalid_variations: string[];
  notes: string;
  severity: 'critical' | 'minor' | 'suggestion';
  /** This question's share of its audit call's usage — the call's cost and token counts divided
   * evenly across every question in its group, applied by `applyGroupUsage` after parsing. Null
   * until applied, and stays null if the call carried no usage data. */
  usage: QuestionUsageShare | null;
  /** The model OpenRouter reports actually served this question's audit call. */
  served_model: string | null;
  /** The host OpenRouter reports actually served this question's audit call. */
  served_provider: string | null;
  /** The id the model echoed in the raw result this was built from, kept for telemetry on how
   * faithfully ids are copied back. Null when no raw result was parsed for the question. */
  echoed_id?: string | null;
  /** This group's audit call's response facts with no column of their own (see
   * `responseMetaFromLlmResult`), applied identically to every question in the group by
   * `applyGroupUsage`. Unlike `usage`, this is the whole call's data and is not divisible, so it
   * must not be summed across the group's questions. Null until applied, and stays null if the
   * call carried none of those facts or never produced a response. */
  response_meta: Record<string, unknown> | null;
}

interface QuestionUsageShare {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  is_byok: boolean | null;
}

function formatQuestionForPrompt(q: QuestionRow): string {
  const lines: string[] = [];
  lines.push(`ID: ${q.id}`);
  lines.push(`Question type: ${q.type}${q.writing_type ? ` (${q.writing_type})` : ''}`);
  lines.push(`Topic: ${q.topic}`);
  lines.push(`Difficulty: ${q.difficulty}`);
  lines.push(`Question: ${q.question}`);

  if (q.type === 'multiple-choice' && q.options) {
    lines.push(`Options: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(' | ')}`);
  }

  lines.push(`Correct answer: ${q.correct_answer}`);

  if (q.acceptable_variations && q.acceptable_variations.length > 0) {
    lines.push(`Acceptable variations: ${q.acceptable_variations.join(', ')}`);
  }

  return lines.join('\n');
}

/** The reference-material preamble shown once before a group's material block — repeats the
 * prompt-level rule inline so it stays attached to the excerpts it governs even after the system
 * and user messages are concatenated by the model. */
const MATERIALS_PREAMBLE =
  'Reference material for this batch\'s topics, from the course markdown each question below is ' +
  'drawn from. Vocabulary, expressions, register, and phrasing that appear in this material are ' +
  'correct and in-scope for this course — do not fail a gate criterion merely because a phrase ' +
  'is informal, regional, or unfamiliar to you if it appears here. A real grammar or factual ' +
  'error can still exist even in taught material; judge the actual French, not your expectation ' +
  'of the level.';

export function buildAuditUserPrompt(questions: QuestionRow[], units: MaterialsUnit[]): string {
  const questionsText = questions
    .map((q, i) => `--- Question ${i + 1} ---\n${formatQuestionForPrompt(q)}`)
    .join('\n\n');

  const materialsBlock = buildAuditMaterialsBlock(
    questions.map((q) => ({ unitId: q.unit_id, topic: q.topic })),
    units,
  );
  const materialsSection = materialsBlock ? `${MATERIALS_PREAMBLE}\n\n${materialsBlock}\n\n` : '';

  return `${materialsSection}Evaluate the following ${questions.length} question(s). Return a JSON array with one result object per question, in the same order.\n\n${questionsText}`;
}

/** The call settings one Mistral audit group is made with — model and settings taken as explicit
 * arguments rather than read from `MODELS`, so a caller other than `questions-audit.ts` (which
 * always passes `MODELS.mistralAudit`) can reuse this implementation with a different model instead
 * of building the request body by hand. */
export interface AuditCallSettings {
  model: string;
  temperature?: number;
  reasoning?: LlmCallOptions['reasoning'];
  disableReasoning?: boolean;
  provider?: LlmCallOptions['provider'];
  providerOnly?: string;
  sessionId?: string;
}

/**
 * Audits one group with the given model/settings: builds the system and user prompts the same way
 * production does, calls the model, parses the response, and attaches usage. `callLlmFn` is an
 * injection point for tests and defaults to the real `callLlm`.
 */
export async function callMistralAuditGroup(
  questions: QuestionRow[],
  units: MaterialsUnit[],
  settings: AuditCallSettings,
  callLlmFn: typeof callLlm = callLlm,
): Promise<MistralAuditResult[]> {
  const result = await callLlmFn({
    model: settings.model,
    messages: [
      { role: 'system', content: renderedMistralAuditSystemPrompt() },
      { role: 'user', content: buildAuditUserPrompt(questions, units) },
    ],
    temperature: settings.temperature,
    jsonMode: true,
    reasoning: settings.reasoning,
    disableReasoning: settings.disableReasoning,
    provider: settings.provider,
    providerOnly: settings.providerOnly,
    sessionId: settings.sessionId,
  });

  return applyGroupUsage(parseAuditResponse(result.text, questions), result.usage, result.servedModel, result.servedProvider, responseMetaFromLlmResult(result));
}

/** The "assume passing, note the reason" fallback shared by a parse failure and an API/transport error. */
export function buildPassthroughResults(questions: QuestionRow[], note: string): MistralAuditResult[] {
  return questions.map((q) => ({
    id: q.id,
    topic: q.topic,
    type: q.type,
    writing_type: q.writing_type,
    generated_by: q.generated_by,
    question: q.question,
    answer: q.correct_answer,
    answer_correct: true,
    grammar_correct: true,
    no_hallucination: true,
    question_coherent: true,
    natural_language: true,
    register_appropriate: true,
    difficulty_appropriate: true,
    suggested_difficulty: null,
    variations_valid: true,
    culturally_appropriate: true,
    missing_variations: [],
    invalid_variations: [],
    notes: note,
    severity: 'suggestion' as const,
    usage: null,
    served_model: null,
    served_provider: null,
    echoed_id: null,
    response_meta: null,
  }));
}

export interface AuditGroupRetryOptions {
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  sleepFn: (ms: number) => Promise<void>;
  /** Called once per rate-limited retry, before the backoff sleep. */
  onRateLimited?: (attempt: number, backoffMs: number) => void;
  /** Called once if a rate limit persists through every retry. */
  onRateLimitExhausted?: () => void;
  /** Called once for a non-retryable (non-429) error. */
  onNonRetryableError?: (err: unknown) => void;
  /** Called once after a successful audit call. */
  onSuccess?: () => void;
}

/**
 * Audits one group with Mistral, retrying a 429 with exponential backoff up to `maxRetries`
 * times. A non-429 error (bad request, auth, anything that isn't rate limiting) is never
 * retried — it falls back to a passthrough result immediately, so a permanent failure produces
 * exactly one result per question instead of accumulating a passthrough on every failed attempt
 * before the retry budget runs out.
 */
export async function auditGroupWithRetry(
  auditFn: (group: QuestionRow[]) => Promise<MistralAuditResult[]>,
  group: QuestionRow[],
  opts: AuditGroupRetryOptions,
): Promise<MistralAuditResult[]> {
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const results = await auditFn(group);
      opts.onSuccess?.();
      return results;
    } catch (err) {
      const errStr = String(err);
      const is429 = (err instanceof LlmError && err.status === 429) || errStr.toLowerCase().includes('rate limit');

      if (is429 && attempt < opts.maxRetries) {
        const backoff = Math.min(opts.initialBackoffMs * Math.pow(2, attempt), opts.maxBackoffMs);
        opts.onRateLimited?.(attempt, backoff);
        await opts.sleepFn(backoff);
        continue;
      }

      if (is429) {
        opts.onRateLimitExhausted?.();
      } else {
        opts.onNonRetryableError?.(err);
      }

      return buildPassthroughResults(group, `API_ERROR: ${errStr.substring(0, 200)}`);
    }
  }

  // Unreachable — the loop above always returns. TS can't see that the maxRetries+1st iteration's
  // catch block always returns too, so it needs an exhaustive fallback here.
  return buildPassthroughResults(group, 'API_ERROR: retry loop exhausted');
}

/** The six gate criteria a valid per-question result must carry as explicit booleans. Soft
 * signals (difficulty_appropriate, variations_valid, culturally_appropriate) are informational
 * and may default when absent — only these decide whether a question can be activated. */
const GATE_CRITERIA = [
  'answer_correct',
  'grammar_correct',
  'no_hallucination',
  'question_coherent',
  'natural_language',
  'register_appropriate',
] as const;

/**
 * Builds one question's result from its matched raw result, or a PARSE_ERROR passthrough if the
 * raw result is missing a gate criterion.
 */
function buildResultFromRaw(q: QuestionRow, r: Record<string, unknown>): MistralAuditResult {
  const echoedId = typeof r.id === 'string' ? r.id : null;
  const missingCriteria = GATE_CRITERIA.filter((c) => typeof r[c] !== 'boolean');
  if (missingCriteria.length > 0) {
    return {
      ...buildPassthroughResults(
        [q],
        `PARSE_ERROR: missing criteria [${missingCriteria.join(', ')}] for question ${q.id}`,
      )[0],
      echoed_id: echoedId,
    };
  }

  return {
    id: q.id,
    topic: q.topic,
    type: q.type,
    writing_type: q.writing_type,
    generated_by: q.generated_by,
    question: q.question,
    answer: q.correct_answer,
    answer_correct: r.answer_correct as boolean,
    grammar_correct: r.grammar_correct as boolean,
    no_hallucination: r.no_hallucination as boolean,
    question_coherent: r.question_coherent as boolean,
    natural_language: r.natural_language as boolean,
    register_appropriate: r.register_appropriate as boolean,
    difficulty_appropriate: typeof r.difficulty_appropriate === 'boolean' ? r.difficulty_appropriate : true,
    suggested_difficulty: (typeof r.suggested_difficulty === 'string' ? r.suggested_difficulty : null),
    variations_valid: typeof r.variations_valid === 'boolean' ? r.variations_valid : true,
    culturally_appropriate: typeof r.culturally_appropriate === 'boolean' ? r.culturally_appropriate : true,
    missing_variations: Array.isArray(r.missing_variations) ? r.missing_variations as string[] : [],
    invalid_variations: Array.isArray(r.invalid_variations) ? r.invalid_variations as string[] : [],
    notes: (r.notes as string) || 'OK',
    severity: (['critical', 'minor', 'suggestion'].includes(r.severity as string) ? r.severity : 'suggestion') as 'critical' | 'minor' | 'suggestion',
    usage: null,
    served_model: null,
    served_provider: null,
    echoed_id: echoedId,
    response_meta: null,
  };
}

/** Removes a Markdown code fence (```json ... ```) wrapped around a JSON response. Some models
 * emit one even in JSON mode; the fence is never part of the payload. */
function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/**
 * Parses one audit call's raw response text into per-question results. A call auditing more than
 * one question matches each result to its question by the `id` the result is required to carry
 * (never by array position — a short, reordered, or malformed response must not silently activate
 * the wrong question). A call auditing exactly one question matches its single result to that
 * question by position instead, regardless of the `id` on it: Mistral corrupts one hex character
 * of the echoed UUID on a small fraction of single-question audits, and with only one question in
 * the call there is nothing else the result could belong to. Never throws: a question with no
 * matching result, or a result missing a gate criterion, becomes a per-question PARSE_ERROR
 * passthrough rather than a pass, so it stays pending instead of being written.
 */
export function parseAuditResponse(content: string, questions: QuestionRow[]): MistralAuditResult[] {
  let rawResults: Record<string, unknown>[];
  try {
    const parsed = JSON.parse(stripCodeFence(content));
    // Handle both array and { results: [...] } formats
    rawResults = Array.isArray(parsed) ? parsed : (parsed.results || parsed.questions || [parsed]);
  } catch {
    logger.error('Parse error for batch', { rawResponse: content.substring(0, 300) });
    return buildPassthroughResults(questions, `PARSE_ERROR: ${content.substring(0, 200)}`);
  }

  if (questions.length === 1 && rawResults.length === 1) {
    return [buildResultFromRaw(questions[0], rawResults[0])];
  }

  // A duplicate id is the same class of ambiguity as a missing one — which of the two results
  // actually belongs to this question can't be known, so neither is used (fail closed, not
  // last-wins): the id is removed from resultById entirely and recorded in duplicateIds instead.
  const resultById = new Map<string, Record<string, unknown>>();
  const duplicateIds = new Set<string>();
  for (const r of rawResults) {
    if (typeof r?.id !== 'string') continue;
    if (resultById.has(r.id)) {
      duplicateIds.add(r.id);
      resultById.delete(r.id);
      continue;
    }
    if (!duplicateIds.has(r.id)) {
      resultById.set(r.id, r);
    }
  }

  return questions.map((q) => {
    if (duplicateIds.has(q.id)) {
      return buildPassthroughResults([q], `PARSE_ERROR: multiple results returned for question ${q.id}`)[0];
    }

    const r = resultById.get(q.id);
    if (!r) {
      return buildPassthroughResults([q], `PARSE_ERROR: no result returned for question ${q.id}`)[0];
    }

    return buildResultFromRaw(q, r);
  });
}

/**
 * Attaches a completed audit call's usage to every result it produced: cost and token counts
 * divided evenly across the group (there is no finer-grained attribution — one call audits the
 * whole group at once), so summing every question's share in a run recovers the run's total to
 * floating-point precision. A no-op when `usage` is undefined (the call carried no usage data).
 */
export function applyGroupUsage(
  results: MistralAuditResult[],
  usage: LlmUsage | undefined,
  servedModel: string | undefined,
  servedProvider?: string | undefined,
  responseMeta?: Record<string, unknown> | undefined,
): MistralAuditResult[] {
  if (!usage && !servedModel && !servedProvider && !responseMeta) return results;
  const n = results.length || 1;
  const share: QuestionUsageShare | null = usage
    ? {
        prompt_tokens: usage.promptTokens !== undefined ? usage.promptTokens / n : null,
        completion_tokens: usage.completionTokens !== undefined ? usage.completionTokens / n : null,
        reasoning_tokens: usage.reasoningTokens !== undefined ? usage.reasoningTokens / n : null,
        cost_usd: usage.costUsd !== undefined ? usage.costUsd / n : null,
        is_byok: usage.isByok ?? null,
      }
    : null;
  return results.map((r) => ({
    ...r,
    usage: share,
    served_model: servedModel ?? null,
    served_provider: servedProvider ?? null,
    response_meta: responseMeta ?? null,
  }));
}

/** Recovers a run's total usage from its results' per-question shares (`applyGroupUsage` divided
 * evenly, so summing them back gives the original totals to floating-point precision — dividing a
 * cost by a group size and summing the shares isn't guaranteed to reproduce the exact original
 * float, though the residual is far below `formatUsageSummary`'s 4-decimal rounding) — `calls`
 * isn't recoverable this way and is supplied by the caller, which knows how many audit calls
 * actually ran. */
export function sumResultUsage(results: MistralAuditResult[], calls: number): UsageTotals {
  const totals = emptyUsageTotals();
  totals.calls = calls;
  for (const r of results) {
    if (!r.usage) continue;
    totals.prompt_tokens += r.usage.prompt_tokens ?? 0;
    totals.completion_tokens += r.usage.completion_tokens ?? 0;
    totals.reasoning_tokens += r.usage.reasoning_tokens ?? 0;
    totals.cost_usd += r.usage.cost_usd ?? 0;
  }
  return totals;
}

export function buildAuditBatchRequests(groups: QuestionRow[][], systemPrompt: string, units: MaterialsUnit[]): BatchRequestSpec[] {
  return groups.map((group, i) => ({
    customId: `group-${i}`,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: buildAuditUserPrompt(group, units) },
    ],
    temperature: 0.1,
    jsonMode: true,
  }));
}

/** Pulls the same choices[0].message.content shape a sync call's body carries out of one batch result item's response body. */
function extractBatchResultContent(body: unknown): string | null {
  const content = (body as OpenRouterResponseBody)?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : null;
}

/** Maps one completed batch's per-group result item (response or error) to that group's audit
 * results, attaching that call's usage/served-model share the same way the sync path does. */
export function resultsForGroupItem(item: BatchResultItem, groupQuestions: QuestionRow[]): MistralAuditResult[] {
  if (item.error) {
    return buildPassthroughResults(groupQuestions, `API_ERROR: ${item.error.message}`.substring(0, 200));
  }
  const content = item.response ? extractBatchResultContent(item.response.body) : null;
  if (content === null) {
    return buildPassthroughResults(groupQuestions, 'API_ERROR: missing content in batch result');
  }
  const parsed = parseAuditResponse(content, groupQuestions);
  const body = item.response?.body as OpenRouterResponseBody | undefined;
  return applyGroupUsage(parsed, body ? parseUsage(body) : undefined, body?.model, body?.provider, body ? responseMetaFromLlmResult({ raw: body }) : undefined);
}

// ── llm_batch_jobs bookkeeping ──────────────────────────────────────────────

export interface LlmBatchJobRow {
  id: string;
  provider_batch_id: string;
  stage: 'audit';
  pipeline_batch_id: string;
  unit_id: string | null;
  model: string;
  provider_only: string | null;
  status: string;
  request_counts: RequestCounts | null;
  custom_id_context: Record<string, string[]>;
  error: unknown | null;
  is_fallback_applied: boolean;
  submitted_at: string;
  completed_at: string | null;
  applied_at: string | null;
  /** Sum of every request's usage.cost in this job, written on apply. Absent (rather than merely
   * null) until the pending migration adding this column has been applied — see `update()`'s
   * tolerance for a missing-column error. */
  total_cost_usd: number | null;
}

export type NewLlmBatchJobRow = Pick<LlmBatchJobRow, 'provider_batch_id' | 'stage' | 'pipeline_batch_id' | 'model' | 'custom_id_context'> &
  Partial<Pick<LlmBatchJobRow, 'unit_id' | 'provider_only' | 'status' | 'request_counts'>>;

export interface BatchJobStore {
  insert(row: NewLlmBatchJobRow): Promise<LlmBatchJobRow>;
  get(id: string): Promise<LlmBatchJobRow | null>;
  update(id: string, patch: Partial<LlmBatchJobRow>): Promise<void>;
  /** Atomic conditional claim: sets applied_at = now() only if it was still null. Returns whether THIS call claimed it. */
  claim(id: string): Promise<boolean>;
}

export function createSupabaseBatchJobStore(supabase: SupabaseClient): BatchJobStore {
  return {
    async insert(row) {
      const { data, error } = await supabase.from(JOBS_TABLE).insert(row).select().single();
      if (error || !data) {
        throw new Error(`Failed to insert llm_batch_jobs row: ${error?.message}`);
      }
      return data as LlmBatchJobRow;
    },
    async get(id) {
      const { data, error } = await supabase.from(JOBS_TABLE).select().eq('id', id).maybeSingle();
      if (error) {
        throw new Error(`Failed to fetch llm_batch_jobs row ${id}: ${error.message}`);
      }
      return (data as LlmBatchJobRow) ?? null;
    },
    async update(id, patch) {
      const { error } = await supabase.from(JOBS_TABLE).update(patch).eq('id', id);
      if (error) {
        // Postgres 42703 = undefined_column. total_cost_usd ships as a separate migration the
        // user applies manually (see supabase/migrations/) — until then, skip that one field
        // rather than failing the whole apply over a column that doesn't exist yet.
        if (error.code === '42703' && 'total_cost_usd' in patch) {
          logger.warn(`llm_batch_jobs.total_cost_usd column not found — skipping cost write for job ${id}. Apply the pending migration to enable it.`);
          const { total_cost_usd: _totalCostUsd, ...rest } = patch;
          if (Object.keys(rest).length === 0) return;
          const { error: retryError } = await supabase.from(JOBS_TABLE).update(rest).eq('id', id);
          if (retryError) {
            throw new Error(`Failed to update llm_batch_jobs row ${id}: ${retryError.message}`);
          }
          return;
        }
        throw new Error(`Failed to update llm_batch_jobs row ${id}: ${error.message}`);
      }
    },
    async claim(id) {
      const { data, error } = await supabase
        .from(JOBS_TABLE)
        .update({ applied_at: new Date().toISOString() })
        .eq('id', id)
        .is('applied_at', null)
        .select('id');
      if (error) {
        throw new Error(`Failed to claim llm_batch_jobs row ${id}: ${error.message}`);
      }
      return (data?.length ?? 0) > 0;
    },
  };
}

export async function fetchQuestionsByIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<QuestionRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('questions')
    .select('id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, generated_by, options, acceptable_variations')
    .in('id', ids);
  if (error) {
    throw new Error(`Fetch error: ${error.message}`);
  }
  return (data as QuestionRow[]) ?? [];
}

// ── Submit ───────────────────────────────────────────────────────────────

export interface SubmitAuditDeps {
  store: BatchJobStore;
  submitBatchFn: (options: {
    model: string;
    requests: BatchRequestSpec[];
    providerOnly?: string;
  }) => Promise<{ id: string; status: string; requestCounts: RequestCounts }>;
  systemPrompt: string;
  batchModel: string;
  pipelineBatchId: string;
  /** Every unit a submitted question could reference — passed through to `buildAuditBatchRequests`
   * so each request group's prompt carries its topics' reference material, the same as the sync
   * audit path. */
  units: MaterialsUnit[];
  unitId?: string;
}

export interface SubmitAuditResult {
  jobId: string;
  providerBatchId: string;
  groupCount: number;
}

export async function submitAuditJob(
  questions: QuestionRow[],
  deps: SubmitAuditDeps,
): Promise<SubmitAuditResult> {
  const groups = chunk(questions, AUDIT_GROUP_SIZE);
  const requests = buildAuditBatchRequests(groups, deps.systemPrompt, deps.units);

  const submitResult = await deps.submitBatchFn({
    model: deps.batchModel,
    requests,
    providerOnly: 'Mistral',
  });

  const customIdContext: Record<string, string[]> = {};
  groups.forEach((group, i) => {
    customIdContext[`group-${i}`] = group.map((q) => q.id);
  });

  const row = await deps.store.insert({
    provider_batch_id: submitResult.id,
    stage: 'audit',
    pipeline_batch_id: deps.pipelineBatchId,
    unit_id: deps.unitId ?? null,
    model: deps.batchModel,
    provider_only: 'Mistral',
    status: submitResult.status,
    request_counts: submitResult.requestCounts,
    custom_id_context: customIdContext,
  });

  return { jobId: row.id, providerBatchId: submitResult.id, groupCount: groups.length };
}

// ── Apply (quality_status + audit_metadata write-db logic, shared by sync and batch) ──────

export interface ApplyAuditResultsOptions {
  auditorModel: string;
  pendingOnly?: boolean;
  /** sha256 (16 hex) of the rendered audit system prompt, stored in audit_metadata for provenance. */
  promptHash?: string;
}

export interface ApplyAuditResultsSummary {
  activeCount: number;
  flaggedCount: number;
  errorCount: number;
  difficultyRelabeled: number;
  variationsRemoved: number;
}

export const EMPTY_AUDIT_RESULTS_SUMMARY: ApplyAuditResultsSummary = {
  activeCount: 0,
  flaggedCount: 0,
  errorCount: 0,
  difficultyRelabeled: 0,
  variationsRemoved: 0,
};

/** Adds two summaries field-by-field — how a streaming caller accumulates a running total across groups. */
export function mergeAuditResultsSummaries(
  a: ApplyAuditResultsSummary,
  b: ApplyAuditResultsSummary,
): ApplyAuditResultsSummary {
  return {
    activeCount: a.activeCount + b.activeCount,
    flaggedCount: a.flaggedCount + b.flaggedCount,
    errorCount: a.errorCount + b.errorCount,
    difficultyRelabeled: a.difficultyRelabeled + b.difficultyRelabeled,
    variationsRemoved: a.variationsRemoved + b.variationsRemoved,
  };
}

const isError = (r: MistralAuditResult) =>
  r.notes.startsWith('PARSE_ERROR:') || r.notes.startsWith('API_ERROR:');

const isGatePass = (r: MistralAuditResult) =>
  r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent &&
  r.natural_language && r.register_appropriate;

/**
 * Writes one group's quality_status + audit_metadata (plus difficulty relabeling and invalid
 * variation removal for passing questions) to the database. Produces no console output — a
 * streaming caller applies this once per group as it completes and reports the accumulated total
 * afterward with `summarizeAuditResultsWrite()`; `applyAuditResults()` wraps a single call to this
 * with that same report, for a caller that has all of its results in hand at once.
 */
export async function applyAuditResultsForGroup(
  supabase: SupabaseClient,
  results: MistralAuditResult[],
  questions: QuestionRow[],
  opts: ApplyAuditResultsOptions,
): Promise<ApplyAuditResultsSummary> {
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  const buildAuditMetadata = (r: MistralAuditResult) => ({
    auditor: 'mistral',
    model: opts.auditorModel,
    audited_at: new Date().toISOString(),
    gate_criteria: {
      answer_correct: r.answer_correct,
      grammar_correct: r.grammar_correct,
      no_hallucination: r.no_hallucination,
      question_coherent: r.question_coherent,
      natural_language: r.natural_language,
      register_appropriate: r.register_appropriate,
    },
    soft_signals: {
      difficulty_appropriate: r.difficulty_appropriate,
      suggested_difficulty: r.suggested_difficulty,
      variations_valid: r.variations_valid,
      missing_variations: r.missing_variations,
      invalid_variations: r.invalid_variations,
      culturally_appropriate: r.culturally_appropriate,
    },
    severity: r.severity,
    notes: r.notes,
    usage: r.usage,
    served_model: r.served_model,
    prompt_hash: opts.promptHash ?? null,
  });

  // Keyed by id so the counts below only credit a relabel/cleanup once the write of that row is
  // actually confirmed (see `activeIds` below) — a row whose write fails must not count as
  // relabeled or cleaned up.
  const relabels = new Map<string, { from: string | undefined; to: string }>();
  const variationRemovals = new Map<string, { removed: number; from: number; to: number }>();

  // Only the columns this audit changes are sent: `difficulty` when relabeled, and
  // `acceptable_variations` when an invalid one is removed. Writing a column's current value back
  // would overwrite an edit made between the fetch and the write, which on the batch-resume apply
  // path can be hours apart. Flagged rows never get remediation, so they carry nothing extra.
  const buildExtraColumns = (r: MistralAuditResult) => {
    const question = questionMap.get(r.id);
    if (!question) {
      throw new Error(`buildExtraColumns: no question in questionMap for result id ${r.id}`);
    }
    const currentDifficulty = question.difficulty;
    const currentVariations = question.acceptable_variations || [];

    if (!isGatePass(r)) {
      return {};
    }

    const suggestedDifficulty = r.suggested_difficulty;
    const shouldRelabel = suggestedDifficulty &&
      isDifficulty(suggestedDifficulty) &&
      suggestedDifficulty !== currentDifficulty;

    const invalidVariations = r.invalid_variations || [];
    const shouldRemoveVariations = invalidVariations.length > 0 && currentVariations.length > 0;
    const cleanedVariations = shouldRemoveVariations
      ? currentVariations.filter((v) => !invalidVariations.includes(v))
      : currentVariations;

    if (shouldRelabel) {
      relabels.set(r.id, { from: currentDifficulty, to: suggestedDifficulty });
    }
    if (cleanedVariations.length !== currentVariations.length) {
      variationRemovals.set(r.id, {
        removed: currentVariations.length - cleanedVariations.length,
        from: currentVariations.length,
        to: cleanedVariations.length,
      });
    }

    const extra: Record<string, unknown> = {};
    if (shouldRelabel) extra.difficulty = suggestedDifficulty;
    if (cleanedVariations.length !== currentVariations.length) extra.acceptable_variations = cleanedVariations;
    return extra;
  };

  const { activeIds, flaggedIds, errorCount } = await applyAuditWrites(supabase, results, {
    logger,
    isError,
    isGatePass,
    buildMetadata: buildAuditMetadata,
    buildExtraColumns,
  });

  let difficultyRelabeled = 0;
  let variationsRemoved = 0;
  for (const id of activeIds) {
    const relabel = relabels.get(id);
    if (relabel) {
      difficultyRelabeled++;
      logger.debug(`Difficulty re-label: ${id} ${relabel.from} -> ${relabel.to}`);
    }
    const removal = variationRemovals.get(id);
    if (removal) {
      variationsRemoved += removal.removed;
      logger.debug(`Variations removed: ${id} removed ${removal.removed} invalid (${removal.from} -> ${removal.to})`);
    }
  }

  return {
    activeCount: activeIds.length,
    flaggedCount: flaggedIds.length,
    errorCount,
    difficultyRelabeled,
    variationsRemoved,
  };
}

/** Prints the same "WRITING QUALITY STATUS..." report `applyAuditResults()` has always printed,
 * against a summary that may be the accumulated total of several `applyAuditResultsForGroup()`
 * calls rather than a single one. */
export function summarizeAuditResultsWrite(summary: ApplyAuditResultsSummary, opts: ApplyAuditResultsOptions): void {
  console.log('\n' + '='.repeat(60));
  console.log('WRITING QUALITY STATUS + AUDIT METADATA TO DATABASE');
  console.log('='.repeat(60));

  if (summary.flaggedCount > 0) {
    console.log(`  Marked ${summary.flaggedCount} questions as 'flagged' (with audit_metadata)`);
  }

  if (summary.activeCount > 0) {
    console.log(`  Marked ${summary.activeCount} questions as 'active' (with audit_metadata)`);
    if (summary.difficultyRelabeled > 0) {
      console.log(`  Re-labeled difficulty on ${summary.difficultyRelabeled} questions (Mistral suggested_difficulty)`);
    }
    if (summary.variationsRemoved > 0) {
      console.log(`  Removed ${summary.variationsRemoved} invalid variations across passing questions`);
    }
  }

  if (summary.errorCount > 0) {
    console.log(`  Skipped ${summary.errorCount} questions with errors (status unchanged)`);
  }

  if (opts.pendingOnly) {
    console.log('\n  Promotion summary (pending questions, counts are successful database writes):');
    console.log(`    Promoted to active:  ${summary.activeCount}`);
    console.log(`    Flagged:             ${summary.flaggedCount}`);
    if (summary.errorCount > 0) {
      console.log(`    Still pending:       ${summary.errorCount} (parse/API errors)`);
    }
  }
}

/**
 * Single-shot entry point for a caller (the `--llm-batch-resume` apply path) that has every
 * result in hand at once: writes them all via `applyAuditResultsForGroup()` and prints the same
 * report a streaming caller builds from `summarizeAuditResultsWrite()` after its own loop.
 */
export async function applyAuditResults(
  supabase: SupabaseClient,
  results: MistralAuditResult[],
  questions: QuestionRow[],
  opts: ApplyAuditResultsOptions,
): Promise<ApplyAuditResultsSummary> {
  const summary = await applyAuditResultsForGroup(supabase, results, questions, opts);
  summarizeAuditResultsWrite(summary, opts);
  return summary;
}

// ── Resume ───────────────────────────────────────────────────────────────

/** One sticky-routing session id per fallback run, shared across every group's sync call — mirrors how the sync CLI path builds one `${runId}:audit` id for its whole loop rather than one per group. */
export function buildFallbackSessionId(jobId: string): string {
  return `${jobId}:audit-fallback`;
}

export interface ResumeAuditDeps {
  store: BatchJobStore;
  pollUntilDoneFn: (options: { batchId: string }) => Promise<PollOutcome>;
  fetchQuestionsByIdsFn: (ids: string[]) => Promise<QuestionRow[]>;
  /** The existing sync audit call (one group, no retry loop) — used only for the whole-batch-failure fallback. */
  syncAuditFn: (questions: QuestionRow[]) => Promise<MistralAuditResult[]>;
  applyResultsFn: (
    results: MistralAuditResult[],
    questions: QuestionRow[],
    auditorModel: string,
  ) => Promise<ApplyAuditResultsSummary>;
  /** Matches the CLI's --write-db flag: gates writes to questions, not to llm_batch_jobs. */
  writeDb: boolean;
  /** Sync-endpoint model used for the whole-batch-failure fallback (the sync auditor model). */
  fallbackModel: string;
  now?: () => string;
}

export type ResumeAuditOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_applied' }
  | { kind: 'still_running'; requestCounts: RequestCounts }
  | { kind: 'poll_error'; message: string; status?: number }
  | { kind: 'terminal_no_fallback'; status: string }
  | { kind: 'no_questions_resolved' }
  | { kind: 'claim_lost' }
  | { kind: 'preview_only' }
  | { kind: 'applied_via_fallback'; summary: ApplyAuditResultsSummary; usage: UsageTotals }
  | { kind: 'applied'; summary: ApplyAuditResultsSummary; usage: UsageTotals };

function groupQuestionsFor(ids: string[], questionById: Map<string, QuestionRow>): QuestionRow[] {
  return ids.map((id) => questionById.get(id)).filter((q): q is QuestionRow => !!q);
}

/** Fetches every question referenced by the job's custom_id_context. */
async function resolveAuditQuestions(deps: ResumeAuditDeps, row: LlmBatchJobRow): Promise<QuestionRow[]> {
  const allIds = Object.values(row.custom_id_context).flat();
  return deps.fetchQuestionsByIdsFn(allIds);
}

/**
 * The --llm-batch-resume state machine: poll, then either report (writeDb false), recover via
 * the sync fallback (whole-batch pre-execution failure), or apply a completed batch's results —
 * always behind the atomic applied_at claim so a second concurrent resume is a no-op.
 */
export async function resumeAuditJob(jobId: string, deps: ResumeAuditDeps): Promise<ResumeAuditOutcome> {
  const row = await deps.store.get(jobId);
  if (!row) {
    return { kind: 'not_found' };
  }

  if (row.applied_at) {
    return { kind: 'already_applied' };
  }

  const nowIso = () => (deps.now ? deps.now() : new Date().toISOString());

  let poll: PollOutcome;
  try {
    poll = await deps.pollUntilDoneFn({ batchId: row.provider_batch_id });
  } catch (err) {
    // A 5xx or network failure while polling says nothing about the batch itself; the next resume
    // can poll again. Client errors (4xx) are real problems and propagate.
    if (err instanceof LlmNetworkError || (err instanceof LlmError && err.status !== undefined && err.status >= 500)) {
      return { kind: 'poll_error', message: err.message, status: err.status };
    }
    throw err;
  }
  await deps.store.update(jobId, {
    status: poll.result.status,
    request_counts: poll.result.requestCounts,
  });

  if (poll.outcome === 'still_running') {
    return { kind: 'still_running', requestCounts: poll.result.requestCounts };
  }

  // Whole-batch pre-execution failure — never reached `in_progress`, so nothing was written yet.
  if (poll.outcome === 'failed' && poll.result.batchError) {
    await deps.store.update(jobId, { error: poll.result.batchError });

    if (!deps.writeDb) {
      return { kind: 'preview_only' };
    }

    const questions = await resolveAuditQuestions(deps, row);
    if (questions.length === 0) {
      return { kind: 'no_questions_resolved' };
    }

    const claimed = await deps.store.claim(jobId);
    if (!claimed) {
      return { kind: 'claim_lost' };
    }

    const questionById = new Map(questions.map((q) => [q.id, q]));
    logger.warn(`Whole-batch failure — falling back to sync audit via ${deps.fallbackModel} (batch job targeted ${row.model}).`);

    const results: MistralAuditResult[] = [];
    let callCount = 0;
    for (const ids of Object.values(row.custom_id_context)) {
      const group = groupQuestionsFor(ids, questionById);
      if (group.length === 0) continue;
      results.push(...(await deps.syncAuditFn(group)));
      callCount++;
    }

    const summary = await deps.applyResultsFn(results, questions, deps.fallbackModel);
    const usage = sumResultUsage(results, callCount);
    // is_fallback_applied only becomes true once the fallback has actually run and its results
    // were applied — a preview-only resume (above) detects and records the failure but runs nothing.
    await deps.store.update(jobId, { completed_at: nowIso(), is_fallback_applied: true, total_cost_usd: usage.cost_usd });
    return { kind: 'applied_via_fallback', summary, usage };
  }

  // A post-execution terminal state (failed/expired/cancelled after execution began): nothing
  // was ever written for this job, so it's safe to resubmit from scratch — no fallback here.
  if (poll.outcome === 'failed' || poll.outcome === 'expired' || poll.outcome === 'cancelled') {
    await deps.store.update(jobId, { completed_at: nowIso() });
    return { kind: 'terminal_no_fallback', status: poll.outcome };
  }

  // Completed. A group with no matching result, or a result whose customId matches no group, is
  // never an audit verdict — record it on the job row and leave those questions pending for a
  // later re-audit rather than fabricating a result for them.
  const resultIds = new Set((poll.result.results ?? []).map((item) => item.customId));
  const contextIds = Object.keys(row.custom_id_context);
  const missingResultIds = contextIds.filter((id) => !resultIds.has(id));
  const unknownResultIds = [...resultIds].filter((id) => !(id in row.custom_id_context));

  if (missingResultIds.length > 0) {
    logger.error(`Batch ${jobId}: no result for group(s) ${missingResultIds.join(', ')} — left pending for re-audit.`);
  }
  if (unknownResultIds.length > 0) {
    logger.error(`Batch ${jobId}: result(s) with unrecognized customId ${unknownResultIds.join(', ')} — ignored.`);
  }
  if (missingResultIds.length > 0 || unknownResultIds.length > 0) {
    await deps.store.update(jobId, { error: { missing_results: missingResultIds, unknown_results: unknownResultIds } });
  }

  if (!deps.writeDb) {
    return { kind: 'preview_only' };
  }

  const questions = await resolveAuditQuestions(deps, row);
  if (questions.length === 0) {
    return { kind: 'no_questions_resolved' };
  }

  const claimed = await deps.store.claim(jobId);
  if (!claimed) {
    return { kind: 'claim_lost' };
  }

  const questionById = new Map(questions.map((q) => [q.id, q]));
  const results: MistralAuditResult[] = [];
  for (const item of poll.result.results ?? []) {
    const ids = row.custom_id_context[item.customId];
    if (!ids) continue; // unrecognized customId — already logged and recorded above
    const group = groupQuestionsFor(ids, questionById);
    if (group.length === 0) continue;
    results.push(...resultsForGroupItem(item, group));
  }

  const summary = await deps.applyResultsFn(results, questions, row.model);
  const usage = sumResultUsage(results, (poll.result.results ?? []).length);
  await deps.store.update(jobId, { completed_at: nowIso(), total_cost_usd: usage.cost_usd });
  return { kind: 'applied', summary, usage };
}
