/**
 * The transcription task's `eval-run` wiring: transcribes each course slide's rendered image (plus
 * its text layer) into markdown through the exact production prompt, and scores the result against
 * a reviewer-checked transcript when one is approved.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  renderSlideImage,
  buildTranscriptionMessageContent,
  cleanConversionArtifacts,
  TRANSCRIPTION_PROMPT_HASH,
  SLIDE_TRANSCRIPTION_MAX_TOKENS,
} from '../../pdf-conversion';
import { createLogger } from '../../logger';
import type { EvalItemRow, NewEvalResultRow } from '../db';
import { planInterleavedCalls } from '../runner';
import { computeTranscriptionDeterministicChecks, scoreTranscription, buildTranscriptionRunSummary, type TranscriptionItemOutcome } from '../transcription-scoring';
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

export const transcriptionTask: EvalTaskDefinition<TranscriptionContext, TranscriptionItemOutcome> = {
  task: 'transcription',

  promptHash() {
    return TRANSCRIPTION_PROMPT_HASH;
  },

  planCalls(items, variants, { blockSize }) {
    return planInterleavedCalls(items, variants, blockSize);
  },

  async prepareContext({ set, items }) {
    const pdfPath = (set.selection as { pdfPath?: string }).pdfPath!;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-transcription-slides-'));
    // Each slide's rendered image is independent of which model will transcribe it, so it's
    // rendered exactly once here and reused across every variant and repeat, rather than once per
    // call the way a production single-model conversion run would.
    const imageBySlide = new Map<number, Buffer>();
    for (const item of items) {
      const slide = item.payload.slide as number;
      if (!imageBySlide.has(slide)) {
        imageBySlide.set(slide, renderSlideImage(pdfPath, slide, tmpDir));
      }
    }
    return { tmpDir, imageBySlide };
  },

  cleanupContext({ tmpDir }) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },

  async runCall({ call, context, run, callSettings, reasoning, callLlmFn, throttleIfMistral }) {
    const key = variantKey(call.variant);
    const outcomes: TranscriptionItemOutcome[] = [];
    const resultRows: NewEvalResultRow[] = [];

    for (const item of call.items) {
      await throttleIfMistral(call.variant.model);
      const startedAt = Date.now();
      const slide = item.payload.slide as number;
      const slideText = String(item.payload.text_layer ?? '');
      const imageBytes = context.imageBySlide.get(slide)!;
      const content = buildTranscriptionMessageContent(slideText, imageBytes);

      let output: string | undefined;
      let error: 'parse' | 'api' | 'empty' | undefined;
      let usage: ResultUsage = {};

      // Every slide is sent to the model, never served from the production slide cache: a
      // cached transcript would record zero cost and disk latency, and make repeats of the
      // baseline identical by construction, which is not the noise floor being measured.
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
        usage = usageFromLlmResult(result);
        output = cleanConversionArtifacts(result.text);
      } catch (err) {
        error = isEmptyContentError(err) ? 'empty' : 'api';
        logger.error(`Slide ${slide} failed for variant ${key} (${error}): ${err instanceof Error ? err.message : String(err)}`);
      }
      const latencyMs = Date.now() - startedAt;

      const reference = transcriptionReferenceFromItem(item);
      const deterministicChecks = output !== undefined ? computeTranscriptionDeterministicChecks(slideText, output) : undefined;
      const score = reference !== undefined && output !== undefined ? scoreTranscription(reference, output) : undefined;

      outcomes.push({
        itemId: item.id,
        slide,
        category: item.payload.category as TranscriptionCategory,
        slideText,
        reference,
        output,
        score,
        deterministicChecks,
        error,
        latencyMs,
        costUsd: usage.cost_usd,
      });
      resultRows.push({
        run_id: run.id,
        item_id: item.id,
        output: output !== undefined ? { markdown: output } : null,
        score: score ?? null,
        deterministic_checks: deterministicChecks
          ? {
              coverage: deterministicChecks.coverage,
              no_content_marker: deterministicChecks.noContentMarker,
              table_rows: deterministicChecks.tableRows,
              table_cols: deterministicChecks.tableCols,
              chars: deterministicChecks.chars,
            }
          : null,
        latency_ms: latencyMs,
        cost_usd: usage.cost_usd ?? null,
        prompt_tokens: wholeTokens(usage.prompt_tokens),
        completion_tokens: wholeTokens(usage.completion_tokens),
        reasoning_tokens: wholeTokens(usage.reasoning_tokens),
        served_model: usage.served_model ?? null,
        served_provider: usage.served_provider ?? null,
        is_byok: usage.is_byok ?? null,
        error: error ?? null,
      });
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildTranscriptionRunSummary(outcomes) as unknown as Record<string, unknown>;
  },
};
