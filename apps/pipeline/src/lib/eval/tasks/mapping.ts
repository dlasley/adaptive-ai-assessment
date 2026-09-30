/**
 * The mapping task's `eval-run` wiring: sends a unit's whole topic list and markdown to the model
 * in a single call per variant per repeat, matching production's `mapExistingHeadings`, and scores
 * each topic's returned headings against the reference set recorded at `eval-set-create` time.
 */

import { readFileSync } from 'fs';
import { buildMapExistingPrompt, parseMapExistingResponse, MapExistingParseError } from '../../topics';
import { extractDocumentHeadings, assertValidSlideMarkers, type HeadingRef, type DocumentHeadingOccurrence } from '../../learning-materials';
import { createLogger } from '../../logger';
import type { EvalItemRow, NewEvalResultRow } from '../db';
import { planInterleavedCalls } from '../runner';
import { headingSetF1, computeMappingDeterministicChecks, buildMappingRunSummary, type MappingItemOutcome } from '../mapping-scoring';
import { withRateLimitRetry } from '../run-loop';
import { usageFromLlmResult, type ResultUsage } from '../usage';
import { MODEL_CALL_RETRY, wholeTokens, isEmptyContentError, hashText } from './shared';
import { variantKey, type EvalTaskDefinition } from './types';

const logger = createLogger('eval-run');

// Matches mapExistingHeadings's own maxTokens (content-suggest-topics.ts) — one call's response
// covers every topic in the set, so it needs the same headroom production's repair mode gives it.
const MAPPING_MAX_TOKENS = 12000;

interface MappingContext {
  markdown: string;
  documentHeadings: DocumentHeadingOccurrence[];
}

/** `eval-set-create --task mapping` writes reference for every item at creation time (deterministic,
 * from the unit's own current headings), so this is never undefined for a mapping item in practice
 * — but it's read defensively the same way the other tasks' reference accessors are. */
function mappingReferenceFromItem(item: EvalItemRow): HeadingRef[] {
  const reference = item.reference as { headings?: HeadingRef[] } | null;
  return reference?.headings ?? [];
}

export const mappingTask: EvalTaskDefinition<MappingContext, MappingItemOutcome> = {
  task: 'mapping',

  promptHash() {
    return hashText(buildMapExistingPrompt([], ''));
  },

  planCalls(items, variants) {
    // One call per variant per repeat, containing every item in the set — matching production's
    // mapExistingHeadings (one call, every topic at once).
    return planInterleavedCalls(items, variants, items.length);
  },

  async prepareContext({ set }) {
    const markdownPath = (set.selection as { markdownPath?: string }).markdownPath!;
    const markdown = readFileSync(markdownPath, 'utf-8');
    assertValidSlideMarkers(markdown, markdownPath);
    return { markdown, documentHeadings: extractDocumentHeadings(markdown) };
  },

  cleanupContext() {},

  async runCall({ call, context, run, callSettings, reasoning, callLlmFn, throttleIfMistral }) {
    const key = variantKey(call.variant);
    const outcomes: MappingItemOutcome[] = [];
    const resultRows: NewEvalResultRow[] = [];

    // planCalls sends every item in one call, so call.items IS the whole topic list.
    const group = call.items;
    const topicNames = group.map((item) => String(item.payload.topic));
    await throttleIfMistral(call.variant.model);
    const startedAt = Date.now();
    const prompt = buildMapExistingPrompt(topicNames, context.markdown);

    let mappings: Record<string, HeadingRef[]> | undefined;
    let error: 'parse' | 'api' | 'empty' | undefined;
    let usage: ResultUsage = {};

    try {
      const result = await withRateLimitRetry(() => callLlmFn({
        model: call.variant.model,
        temperature: callSettings.temperature,
        maxTokens: MAPPING_MAX_TOKENS,
        jsonMode: callSettings.jsonMode,
        // Production always disables reasoning for this call (mapExistingHeadings's
        // disableReasoning: true); --reasoning overrides that default, same as every task.
        reasoning: reasoning ?? { enabled: false },
        provider: callSettings.provider,
        sessionId: run.id,
        messages: [{ role: 'user', content: prompt }],
      }), {
        ...MODEL_CALL_RETRY,
        onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) for variant ${key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
      });
      usage = usageFromLlmResult(result);
      mappings = parseMapExistingResponse(result.text, topicNames);
    } catch (err) {
      if (err instanceof MapExistingParseError) error = 'parse';
      else if (isEmptyContentError(err)) error = 'empty';
      else error = 'api';
      logger.error(`Mapping call failed for variant ${key} (${error}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const latencyMs = Date.now() - startedAt;
    // One call covers every topic; its usage is divided evenly across them, the same way
    // applyGroupUsage divides an audit group call's usage across its questions.
    const n = group.length || 1;
    const share = (value: number | undefined) => (value === undefined ? undefined : value / n);

    for (const item of group) {
      const topic = String(item.payload.topic);
      const reference = mappingReferenceFromItem(item);
      const output = mappings?.[topic];
      const scoring = output ? headingSetF1(reference, output) : undefined;
      const deterministicChecks = output ? computeMappingDeterministicChecks(topic, output, context.documentHeadings) : undefined;
      const itemCostUsd = share(usage.cost_usd);

      outcomes.push({
        itemId: item.id,
        topic,
        reference,
        output,
        scoring,
        deterministicChecks,
        error,
        latencyMs,
        costUsd: itemCostUsd,
      });
      resultRows.push({
        run_id: run.id,
        item_id: item.id,
        output: output ? { headings: output } : null,
        score: scoring?.f1 ?? null,
        deterministic_checks: deterministicChecks
          ? {
              resolved: deterministicChecks.resolved,
              unresolved: deterministicChecks.unresolved,
              unresolved_headings: deterministicChecks.unresolvedHeadings,
              nested_duplicates: deterministicChecks.nestedDuplicates,
            }
          : null,
        latency_ms: latencyMs,
        cost_usd: itemCostUsd ?? null,
        prompt_tokens: wholeTokens(share(usage.prompt_tokens)),
        completion_tokens: wholeTokens(share(usage.completion_tokens)),
        reasoning_tokens: wholeTokens(share(usage.reasoning_tokens)),
        served_model: usage.served_model ?? null,
        served_provider: usage.served_provider ?? null,
        is_byok: usage.is_byok ?? null,
        error: error ?? null,
      });
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildMappingRunSummary(outcomes) as unknown as Record<string, unknown>;
  },
};
