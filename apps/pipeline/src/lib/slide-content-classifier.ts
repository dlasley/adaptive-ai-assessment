/**
 * A separate yes/no call, independent of the transcription prompt, that decides whether one slide
 * teaches the course language. Gating transcription on this decision keeps the transcription model
 * from having to make the same call itself — the failure mode that motivated this module: a
 * transcription prompt heavy enough to reliably exclude non-teaching slides also suppressed content
 * on unrelated slides.
 */

import fs from 'fs';
import path from 'path';
import { callLlm, responseMetaFromLlmResult, type LlmCallOptions, type LlmContentPart, type LlmUsage } from '@adaptive/shared/llm';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { PROMPTS_DIR } from './paths';
import { hashText } from './eval/tasks/shared';

export const CLASSIFY_PROMPT = renderCoursePrompt(
  fs.readFileSync(path.join(PROMPTS_DIR, 'content-classify-slide.md'), 'utf-8')
);

/** sha256 (16 hex) of the rendered classifier prompt, for attributing an exclusion-pass decision
 * to the exact prompt that produced it. */
export const CLASSIFY_PROMPT_HASH = hashText(CLASSIFY_PROMPT);

/** A classifier answer that did not parse. When the call itself returned a response, the host,
 * model, usage and response facts it carried are kept on `response`, so a caller can still record them. */
export class SlideClassificationParseError extends Error {
  constructor(
    message: string,
    readonly response?: {
      servedModel?: string;
      servedProvider?: string;
      responseMeta?: Record<string, unknown>;
      usage?: LlmUsage;
    },
  ) {
    super(message);
  }
}

export interface SlideClassification {
  teachesLanguage: boolean;
  reason: string;
  /** Undefined only if OpenRouter returned no usage object for the call. */
  usage?: LlmUsage;
  /** The model and host OpenRouter reports actually served this classification call. */
  servedModel?: string;
  servedProvider?: string;
  /** This call's response facts with no column of their own; see `responseMetaFromLlmResult`. */
  responseMeta?: Record<string, unknown>;
}

function validateClassificationShape(
  parsed: unknown
): asserts parsed is { teaches_language: boolean; reason: string } {
  const p = parsed as { teaches_language?: unknown; reason?: unknown } | null;
  if (!p || typeof p.teaches_language !== 'boolean' || typeof p.reason !== 'string' || p.reason.trim() === '') {
    throw new SlideClassificationParseError('classifier response missing a valid teaches_language/reason');
  }
}

/** Strips markdown code fences (the prompt asks for none, but a model sometimes adds them anyway),
 * parses JSON, and validates the shape a caller depends on. A malformed or missing answer is
 * always an error, never treated as "teaches the language" — an exclusion pass that failed open on
 * a parse error would defeat the point of gating. */
export function parseSlideClassification(text: string): { teachesLanguage: boolean; reason: string } {
  const cleaned = text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new SlideClassificationParseError('classifier response was not valid JSON');
  }
  validateClassificationShape(parsed);
  return { teachesLanguage: parsed.teaches_language, reason: parsed.reason };
}

/** The exact per-slide message content: the classifier prompt plus a text-layer hint and the
 * rendered slide image — the same inputs the transcription prompt itself sees. */
export function buildClassifyMessageContent(slideText: string, imageBytes: Buffer): LlmContentPart[] {
  const hint = slideText.trim().length > 0
    ? `\n\nText layer extracted from this slide by a PDF text extractor (may be incomplete or out of order — use it as a hint only):\n\n${slideText}`
    : '\n\nNo text layer was extracted from this slide (likely image-only).';
  return [
    { type: 'text', text: CLASSIFY_PROMPT + hint },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } },
  ];
}

export interface ClassifySlideContentParams {
  imageBytes: Buffer;
  slideText: string;
  model: string;
  provider?: LlmCallOptions['provider'];
  reasoning?: LlmCallOptions['reasoning'];
  sessionId?: string;
  /** Injection point for tests. Defaults to the real `callLlm`. */
  callLlmFn?: typeof callLlm;
}

/**
 * Classifies one slide as teaching the course language or not. Never reads or writes the on-disk
 * slide-transcription cache (`pdf-conversion.ts`'s `slideCacheKey`) — that cache is keyed to the
 * transcription prompt and model, and this is a distinct call with its own prompt and model.
 */
export async function classifySlideContent(params: ClassifySlideContentParams): Promise<SlideClassification> {
  const callLlmFn = params.callLlmFn ?? callLlm;
  const content = buildClassifyMessageContent(params.slideText, params.imageBytes);
  const result = await callLlmFn({
    model: params.model,
    jsonMode: true,
    reasoning: params.reasoning ?? { enabled: false },
    provider: params.provider,
    sessionId: params.sessionId,
    messages: [{ role: 'user', content }],
  });
  const responseMeta = responseMetaFromLlmResult(result);
  let classification: { teachesLanguage: boolean; reason: string };
  try {
    classification = parseSlideClassification(result.text);
  } catch (err) {
    if (err instanceof SlideClassificationParseError) {
      throw new SlideClassificationParseError(err.message, { servedModel: result.servedModel, servedProvider: result.servedProvider, responseMeta, usage: result.usage });
    }
    throw err;
  }
  const { teachesLanguage, reason } = classification;
  return {
    teachesLanguage,
    reason,
    usage: result.usage,
    servedModel: result.servedModel,
    servedProvider: result.servedProvider,
    responseMeta,
  };
}
