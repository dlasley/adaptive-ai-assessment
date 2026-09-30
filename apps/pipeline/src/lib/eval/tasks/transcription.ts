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
import type { EvalItemRow, EvalResultRow, NewEvalResultRow } from '../db';
import { planInterleavedCalls } from '../runner';
import { computeTranscriptionDeterministicChecks, scoreTranscription, buildTranscriptionRunSummary, type TranscriptionDeterministicChecks, type TranscriptionItemOutcome } from '../transcription-scoring';
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

      const deterministicChecks = output !== undefined ? computeTranscriptionDeterministicChecks(slideText, output) : undefined;

      const resultRow: NewEvalResultRow = {
        run_id: run.id,
        item_id: item.id,
        output: output !== undefined ? { markdown: output } : null,
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
      };
      const outcome = transcriptionOutcomeFromRow(resultRow as EvalResultRow, item);
      resultRow.score = outcome.score ?? null;
      outcomes.push(outcome);
      resultRows.push(resultRow);
    }

    return { outcomes, resultRows };
  },

  buildSummary(outcomes) {
    return buildTranscriptionRunSummary(outcomes) as unknown as Record<string, unknown>;
  },

  outcomeFromStoredResult(result, item) {
    return transcriptionOutcomeFromRow(result, item);
  },
};
