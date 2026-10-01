/**
 * The transcription task's `eval-run` wiring: transcribes each course slide's rendered image (plus
 * its text layer) into markdown through the exact production prompt, and scores the result against
 * a reviewer-checked transcript when one is approved.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { LlmUsage } from '@adaptive/shared/llm';
import {
  renderSlideImage,
  buildTranscriptionMessageContent,
  cleanConversionArtifacts,
  NO_CONTENT_MARKER,
  TRANSCRIPTION_PROMPT_HASH,
  SLIDE_TRANSCRIPTION_MAX_TOKENS,
} from '../../pdf-conversion';
import { classifySlideContent, SlideClassificationParseError } from '../../slide-content-classifier';
import { createLogger } from '../../logger';
import type { EvalItemRow, EvalResultRow, NewEvalResultRow } from '../db';
import { planInterleavedCalls } from '../runner';
import { computeTranscriptionDeterministicChecks, scoreTranscription, buildTranscriptionRunSummary, type TranscriptionDeterministicChecks, type TranscriptionItemOutcome, type TranscriptionRunSummary } from '../transcription-scoring';
import type { TranscriptionCategory } from '../set-builder';
import { withRateLimitRetry } from '../run-loop';
import { usageFromLlmResult, type ResultUsage } from '../usage';
import { MODEL_CALL_RETRY, wholeTokens, isEmptyContentError } from './shared';
import { variantKey, type EvalTaskDefinition } from './types';

const logger = createLogger('eval-run');

interface TranscriptionContext {
  tmpDir: string;
  imageBySlide: Map<number, Buffer>;
}

/** A transcription item's reference is a checked transcript, reviewed after the fact
 * (`eval-review-export`/`eval-review-import`) — unlike mapping's, it is usually undefined until a
 * reviewer has approved it. */
function transcriptionReferenceFromItem(item: EvalItemRow): string | undefined {
  if (item.reference_status !== 'approved' || !item.reference) return undefined;
  const reference = item.reference as { markdown?: string };
  return typeof reference.markdown === 'string' ? reference.markdown : undefined;
}

/** Rebuilds a transcription outcome from a stored eval_results row and its eval_items row: the
 * output markdown and deterministic checks come off the row, the reference off the item, and the
 * score is recomputed against whichever reference and output the two currently carry — the same
 * scoring call a fresh run makes, so a corrected reference rescores an old run without re-running
 * anything. */
function transcriptionOutcomeFromRow(result: EvalResultRow, item: EvalItemRow): TranscriptionItemOutcome {
  const slide = item.payload.slide as number;
  const slideText = String(item.payload.text_layer ?? '');
  const output = (result.output as { markdown?: string } | null)?.markdown;
  const reference = transcriptionReferenceFromItem(item);
  const score = reference !== undefined && output !== undefined ? scoreTranscription(reference, output) : undefined;
  const dc = result.deterministic_checks as {
    coverage?: number;
    no_content_marker?: boolean;
    table_rows?: number;
    table_cols?: number;
    chars?: number;
  } | null;
  const deterministicChecks: TranscriptionDeterministicChecks | undefined = dc
    ? {
        coverage: dc.coverage ?? 0,
        noContentMarker: !!dc.no_content_marker,
        tableRows: dc.table_rows ?? 0,
        tableCols: dc.table_cols ?? 0,
        chars: dc.chars ?? 0,
      }
    : undefined;

  return {
    itemId: item.id,
    slide,
    category: item.payload.category as TranscriptionCategory,
    slideText,
    reference,
    output,
    score,
    deterministicChecks,
    error: result.error ?? undefined,
    latencyMs: result.latency_ms ?? undefined,
    costUsd: result.cost_usd ?? undefined,
  };
}

/** Sums two ResultUsage objects field by field — a slide gated by an exclusion pass makes two
 * calls (the classifier, then the transcription call when kept) and the result row reports their
 * combined cost and tokens as one figure. `undefined + undefined` stays `undefined` rather than
 * becoming `0`, matching `usageFromLlmResult`'s convention for a field OpenRouter didn't report. */
function addResultUsage(a: ResultUsage, b: ResultUsage): ResultUsage {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    cost_usd: sum(a.cost_usd, b.cost_usd),
    prompt_tokens: sum(a.prompt_tokens, b.prompt_tokens),
    completion_tokens: sum(a.completion_tokens, b.completion_tokens),
    reasoning_tokens: sum(a.reasoning_tokens, b.reasoning_tokens),
    served_model: b.served_model ?? a.served_model,
    served_provider: b.served_provider ?? a.served_provider,
    is_byok: b.is_byok ?? a.is_byok,
  };
}

/** The classifier's own serving host isn't tracked on the result row (only the transcription
 * call's is, via `usageFromLlmResult`), so this carries cost and token counts only. */
function resultUsageFromLlmUsage(usage: LlmUsage | undefined): ResultUsage {
  return {
    cost_usd: usage?.costUsd,
    prompt_tokens: usage?.promptTokens,
    completion_tokens: usage?.completionTokens,
    reasoning_tokens: usage?.reasoningTokens,
    is_byok: usage?.isByok,
  };
}

export const transcriptionTask: EvalTaskDefinition<TranscriptionContext, TranscriptionItemOutcome, TranscriptionRunSummary> = {
  task: 'transcription',

  promptHash() {
    return TRANSCRIPTION_PROMPT_HASH;
  },

  planCalls(items, variants, { blockSize }) {
    return planInterleavedCalls(items, variants, blockSize);
  },

  async prepareContext({ set, items, renderDpi }) {
    const pdfPath = (set.selection as { pdfPath?: string }).pdfPath!;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-transcription-slides-'));
    // Each slide's rendered image is independent of which model will transcribe it, so it's
    // rendered exactly once here and reused across every variant and repeat, rather than once per
    // call the way a production single-model conversion run would.
    const imageBySlide = new Map<number, Buffer>();
    for (const item of items) {
      const slide = item.payload.slide as number;
      if (!imageBySlide.has(slide)) {
        imageBySlide.set(slide, renderSlideImage(pdfPath, slide, tmpDir, renderDpi));
      }
    }
    return { tmpDir, imageBySlide };
  },

  cleanupContext({ tmpDir }) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },

  async runCall({ call, context, run, callSettings, reasoning, callLlmFn, throttleIfMistral, exclusionPass }) {
    const key = variantKey(call.variant);
    const outcomes: TranscriptionItemOutcome[] = [];
    const resultRows: NewEvalResultRow[] = [];

    for (const item of call.items) {
      await throttleIfMistral(call.variant.model);
      const startedAt = Date.now();
      const slide = item.payload.slide as number;
      const slideText = String(item.payload.text_layer ?? '');
      const imageBytes = context.imageBySlide.get(slide)!;

      let output: string | undefined;
      let error: 'parse' | 'api' | 'empty' | undefined;
      let usage: ResultUsage = {};
      let exclusionDecision: 'keep' | 'drop' | undefined;
      let exclusionReason: string | undefined;

      if (exclusionPass) {
        await throttleIfMistral(exclusionPass.model);
        try {
          const classification = await withRateLimitRetry(() => classifySlideContent({
            imageBytes,
            slideText,
            model: exclusionPass.model,
            provider: exclusionPass.provider,
            sessionId: run.id,
            callLlmFn,
          }), {
            ...MODEL_CALL_RETRY,
            onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) classifying slide ${slide} for ${key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
          });
          exclusionDecision = classification.teachesLanguage ? 'keep' : 'drop';
          exclusionReason = classification.reason;
          usage = addResultUsage(usage, resultUsageFromLlmUsage(classification.usage));
        } catch (err) {
          error = err instanceof SlideClassificationParseError ? 'parse' : isEmptyContentError(err) ? 'empty' : 'api';
          logger.error(`Slide ${slide} classification failed for variant ${key} (${error}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // A slide the exclusion pass drops never reaches the transcription call at all. Every slide
      // that does reach it (every slide, when no exclusion pass is active) is sent to the model,
      // never served from the production slide cache: a cached transcript would record zero cost
      // and disk latency, and make repeats of the baseline identical by construction, which is not
      // the noise floor being measured.
      if (error === undefined && exclusionDecision === 'drop') {
        output = NO_CONTENT_MARKER;
      } else if (error === undefined) {
        const content = buildTranscriptionMessageContent(slideText, imageBytes);
        try {
          const result = await withRateLimitRetry(() => callLlmFn({
            model: call.variant.model,
            temperature: callSettings.temperature,
            maxTokens: SLIDE_TRANSCRIPTION_MAX_TOKENS,
            jsonMode: callSettings.jsonMode,
            reasoning: reasoning ?? { enabled: false },
            provider: callSettings.provider,
            sessionId: run.id,
            messages: [{ role: 'user', content }],
          }), {
            ...MODEL_CALL_RETRY,
            onRateLimited: (attempt, backoffMs) => logger.warn(`Rate limited (429) on slide ${slide} for ${key}. Retry ${attempt + 1}/${MODEL_CALL_RETRY.maxRetries} in ${backoffMs / 1000}s...`),
          });
          usage = addResultUsage(usage, usageFromLlmResult(result));
          output = cleanConversionArtifacts(result.text);
        } catch (err) {
          error = isEmptyContentError(err) ? 'empty' : 'api';
          logger.error(`Slide ${slide} failed for variant ${key} (${error}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const latencyMs = Date.now() - startedAt;

      const deterministicChecks = output !== undefined ? computeTranscriptionDeterministicChecks(slideText, output) : undefined;
      const baseChecks = deterministicChecks
        ? {
            coverage: deterministicChecks.coverage,
            no_content_marker: deterministicChecks.noContentMarker,
            table_rows: deterministicChecks.tableRows,
            table_cols: deterministicChecks.tableCols,
            chars: deterministicChecks.chars,
          }
        : null;
      const exclusionChecks = exclusionPass
        ? { exclusion_decision: exclusionDecision ?? null, exclusion_reason: exclusionReason ?? null }
        : null;

      const resultRow: NewEvalResultRow = {
        run_id: run.id,
        item_id: item.id,
        output: output !== undefined ? { markdown: output } : null,
        deterministic_checks: baseChecks || exclusionChecks ? { ...(baseChecks ?? {}), ...(exclusionChecks ?? {}) } : null,
        latency_ms: latencyMs,
        cost_usd: usage.cost_usd ?? null,
        prompt_tokens: wholeTokens(usage.prompt_tokens),
        completion_tokens: wholeTokens(usage.completion_tokens),
        reasoning_tokens: wholeTokens(usage.reasoning_tokens),
        served_model: usage.served_model ?? null,
        served_provider: usage.served_provider ?? null,
        is_byok: usage.is_byok ?? null,
        error: error ?? null,
      };
      const outcome = transcriptionOutcomeFromRow(resultRow as EvalResultRow, item);
      resultRow.score = outcome.score ?? null;
      outcomes.push(outcome);
      resultRows.push(resultRow);
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildTranscriptionRunSummary(outcomes);
  },

  outcomeFromStoredResult(result, item) {
    return transcriptionOutcomeFromRow(result, item);
  },
};
