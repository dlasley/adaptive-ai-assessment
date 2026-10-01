/**
 * The audit task's `eval-run` wiring: groups items into Mistral audit calls (one question per call
 * by default; `--group-size` groups several questions into one call to measure whether sharing a
 * call changes each other's verdicts), scores each verdict against a reviewer's reference or the
 * production auditor's own verdict, and records the auditor's raw notes alongside its output.
 */

import type { Unit } from '@adaptive/shared/types';
import { callMistralAuditGroup, auditGroupWithRetry, renderedMistralAuditSystemPrompt, type QuestionRow as AuditQuestionRow, type MistralAuditResult } from '../../mistral-audit';
import type { EvalItemRow, EvalResultRow, NewEvalResultRow } from '../db';
import { planAuditGroupCalls, buildAuditRunSummary, AUDIT_GATE_CRITERIA, type AuditItemOutcome, type AuditGateCriterion, type AuditRunSummary } from '../runner';
import { createLogger } from '../../logger';
import { MODEL_CALL_RETRY, wholeTokens, hashText, resolveEffectiveSamplingSettings } from './shared';
import { variantKey, type EvalTaskDefinition } from './types';

const logger = createLogger('eval-run');

interface AuditContext {
  units: Unit[];
}

function toAuditQuestionRow(item: EvalItemRow): AuditQuestionRow {
  const p = item.payload;
  return {
    id: item.item_key,
    question: String(p.question),
    correct_answer: String(p.correct_answer),
    type: String(p.type),
    difficulty: String(p.difficulty),
    topic: String(p.topic),
    unit_id: String(p.unit_id),
    writing_type: (p.writing_type as string | null) ?? null,
    generated_by: null,
    options: (p.options as string[] | null) ?? null,
    acceptable_variations: (p.acceptable_variations as string[] | null) ?? null,
  };
}

function auditReferenceFromItem(item: EvalItemRow): Partial<Record<AuditGateCriterion, boolean>> | undefined {
  if (item.reference_status !== 'approved' || !item.reference) return undefined;
  const reference = item.reference as Partial<Record<AuditGateCriterion, boolean>>;
  return Object.fromEntries(AUDIT_GATE_CRITERIA.filter((c) => typeof reference[c] === 'boolean').map((c) => [c, reference[c]]));
}

function auditVerdictFromResult(result: MistralAuditResult): Partial<Record<AuditGateCriterion, boolean>> {
  return Object.fromEntries(AUDIT_GATE_CRITERIA.map((c) => [c, result[c] as boolean]));
}

/** Rebuilds an audit outcome from a stored eval_results row and its eval_items row: the verdict is
 * read back off the row's gate-criteria keys (the row's stored `notes`/`severity`/
 * `suggested_difficulty` are ignored, since the summariser never reads them), reference and the
 * production auditor's own verdict come from the item. */
function auditOutcomeFromRow(result: EvalResultRow, item: EvalItemRow): AuditItemOutcome {
  const storedOutput = result.output as Partial<Record<AuditGateCriterion, boolean>> | null;
  const output = storedOutput
    ? Object.fromEntries(AUDIT_GATE_CRITERIA.filter((c) => typeof storedOutput[c] === 'boolean').map((c) => [c, storedOutput[c]]))
    : undefined;
  const payload = item.payload as { production_audit?: { gate_criteria?: Partial<Record<AuditGateCriterion, boolean>> } | null };
  return {
    itemId: item.id,
    reference: auditReferenceFromItem(item),
    productionAudit: payload.production_audit?.gate_criteria ?? undefined,
    output,
    error: result.error ?? undefined,
    latencyMs: result.latency_ms ?? undefined,
    costUsd: result.cost_usd ?? undefined,
  };
}

export const auditTask: EvalTaskDefinition<AuditContext, AuditItemOutcome, AuditRunSummary> = {
  task: 'audit',

  promptHash() {
    return hashText(renderedMistralAuditSystemPrompt());
  },

  planCalls(items, variants, { blockSize, groupSize }) {
    return planAuditGroupCalls(items, variants, blockSize, groupSize);
  },

  async prepareContext({ supabase, fetchUnitsFromDbFn }) {
    return { units: await fetchUnitsFromDbFn(supabase!) };
  },

  cleanupContext() {},

  async runCall({ call, context, run, callSettings, reasoning, callLlmFn, throttleIfMistral, samplingConstraints }) {
    const key = variantKey(call.variant);
    const outcomes: AuditItemOutcome[] = [];
    const resultRows: NewEvalResultRow[] = [];

    // planAuditGroupCalls splits every call to exactly one audit group (size options.groupSize),
    // so call.items IS the group for a single audit call.
    const group = call.items;
    await throttleIfMistral(call.variant.model);
    const startedAt = Date.now();
    // Audit never disables reasoning by default (unlike mapping/transcription), so only the
    // temperature can need adjusting for a model samplingConstraints flags.
    const { temperature: effectiveTemperature } = resolveEffectiveSamplingSettings(samplingConstraints, callSettings.temperature, reasoning, reasoning !== undefined);
    let groupResults: MistralAuditResult[] | undefined;
    let groupError: 'api' | undefined;
    let groupErrorMessage: string | undefined;
    try {
      // Same rate-limit retry as production's audit: a 429 backs off and retries, so a
      // token-per-minute limit paces the run instead of failing every call after the first burst.
      groupResults = await auditGroupWithRetry(
        (rows) => callMistralAuditGroup(rows, context.units, {
          model: call.variant.model,
          temperature: effectiveTemperature,
          reasoning,
          provider: callSettings.provider,
          sessionId: run.id,
        }, callLlmFn),
        group.map(toAuditQuestionRow),
        {
          maxRetries: MODEL_CALL_RETRY.maxRetries,
          initialBackoffMs: MODEL_CALL_RETRY.initialBackoffMs,
          maxBackoffMs: MODEL_CALL_RETRY.maxBackoffMs,
          sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited for variant ${key}; retry ${attempt} in ${Math.round(backoffMs / 1000)}s`),
        },
      );
      // The helper returns passthrough rows (API_ERROR notes) once retries are exhausted or the
      // error is not retryable; those are recorded per item below as api errors.
    } catch (err) {
      groupError = 'api';
      groupErrorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`Group call failed for variant ${key}: ${groupErrorMessage}`);
    }
    const latencyMs = Date.now() - startedAt;

    for (const item of group) {
      const resultForItem = groupResults?.find((r) => r.id === item.item_key);
      const isParseError = resultForItem?.notes.startsWith('PARSE_ERROR:') || resultForItem?.notes.startsWith('API_ERROR:');
      const output = resultForItem && !isParseError ? auditVerdictFromResult(resultForItem) : undefined;
      const isApiPassthrough = resultForItem?.notes.startsWith('API_ERROR:') ?? false;
      const error: 'parse' | 'api' | undefined = groupError ?? (isApiPassthrough ? 'api' : isParseError ? 'parse' : undefined);
      const errorMessage = groupErrorMessage ?? (isParseError ? resultForItem?.notes : undefined);

      const resultRow: NewEvalResultRow = {
        run_id: run.id,
        item_id: item.id,
        // The stored output keeps the auditor's reasoning beside the verdict so a
        // disagreement can be read later; scoring reads only the criteria keys.
        output: output && resultForItem
          ? { ...output, notes: resultForItem.notes, severity: resultForItem.severity, suggested_difficulty: resultForItem.suggested_difficulty ?? null }
          : null,
        // id_matched reports whether the model echoed this item's id faithfully. A one-question call is
        // matched by position, so a result can be usable while id_matched is false.
        deterministic_checks: { id_matched: resultForItem?.echoed_id === item.item_key, gate_criteria_present: !!output, ...(errorMessage ? { error_message: errorMessage.slice(0, 300) } : {}) },
        latency_ms: latencyMs,
        cost_usd: resultForItem?.usage?.cost_usd ?? null,
        prompt_tokens: wholeTokens(resultForItem?.usage?.prompt_tokens),
        completion_tokens: wholeTokens(resultForItem?.usage?.completion_tokens),
        reasoning_tokens: wholeTokens(resultForItem?.usage?.reasoning_tokens),
        served_model: resultForItem?.served_model ?? null,
        served_provider: resultForItem?.served_provider ?? null,
        is_byok: resultForItem?.usage?.is_byok ?? null,
        error: error ?? null,
        response_meta: resultForItem?.response_meta ?? null,
      };
      outcomes.push(auditOutcomeFromRow(resultRow as EvalResultRow, item));
      resultRows.push(resultRow);
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildAuditRunSummary(outcomes);
  },

  outcomeFromStoredResult(result, item) {
    return auditOutcomeFromRow(result, item);
  },
};
