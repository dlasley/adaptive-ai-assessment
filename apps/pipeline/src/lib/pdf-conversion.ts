/**
 * PDF-to-markdown conversion: renders each slide (one PDF page) as an image, sends it (with
 * that slide's text layer as a hint) to a vision-capable model, and joins the per-slide markdown
 * with slide markers. Course slides are frequently screenshots where the text layer captures only
 * a title, so every slide goes through the vision model rather than relying on extracted text
 * alone.
 */

import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MODELS } from './pipeline-config';
import { callLlm, LlmError, type LlmCallOptions, type LlmContentPart, type LlmResult, type LlmUsage } from '@adaptive/shared/llm';
import { renderCoursePrompt } from '@adaptive/shared/course';
import { classifySlideContent } from './slide-content-classifier';
import { createLogger } from './logger';
import { PROMPTS_DIR, PDF_SLIDE_CACHE_DIR } from './paths';
import { emptyUsageTotals, formatUsageSummary, recordCall, type UsageTotals } from './usage-tracking';
import { sleep } from './sleep';
import { hashText } from './text-hash';

const logger = createLogger('pdf-conversion');

// Load the slide transcription prompt from file (single source of truth)
export const TRANSCRIPTION_PROMPT = renderCoursePrompt(
  fs.readFileSync(path.join(PROMPTS_DIR, 'content-transcribe-pdf-slide.md'), 'utf-8')
);

/** sha256 (16 hex) of the rendered transcription prompt, stored in the conversion report for provenance. */
export const TRANSCRIPTION_PROMPT_HASH = hashText(TRANSCRIPTION_PROMPT);

/** `maxTokens` for one slide's transcription call — production's own value (see `transcribeSlide`),
 * exported so any other caller of the transcription prompt sends an identical call. */
export const SLIDE_TRANSCRIPTION_MAX_TOKENS = 4000;

/** Slides whose text-layer word coverage in the output falls below this are flagged in the report. */
export const MIN_TEXT_COVERAGE = 0.8;

/** Slides with less than this many text-layer characters are reported as image-dominated. */
export const IMAGE_DOMINATED_CHAR_THRESHOLD = 200;

/**
 * Minimum qualifying text-layer words (see normalizeWords) a slide needs before its coverage is
 * checked at all. Below this, the text layer is just a slide title or label (e.g. "Point de
 * depart (8)") and the model legitimately drew all of its content from the image — there's
 * nothing meaningful left to compare the output against, so flagging it would only be noise.
 */
export const MIN_COVERAGE_WORDS = 5;

/** How much of a skipped slide's text layer to keep in the report, for a human to eyeball the skip. */
const SKIPPED_TEXT_PREVIEW_LENGTH = 80;

/** Exact output the transcription prompt asks for on a slide with no teaching content (see
 * content-transcribe-pdf-slide.md's "If the Slide Has No Teaching Content" section) — kept in sync
 * with that file by hand, since the prompt isn't machine-checkable against this constant. */
export const NO_CONTENT_MARKER = '<!-- no teaching content -->';

/** Default resolution for rendered slide images, high enough to keep slide text legible at
 * reasonable token cost. Exported so a caller that overrides it (see `renderSlideImage`) can refer
 * to the same value eval-run's `--render-dpi` defaults to. */
export const DEFAULT_RENDER_DPI = 120;

/** Bounded slide-transcription concurrency. Rate-limit responses are handled separately via backoff
 * (see callLlmWithRateLimitBackoff) since a fixed worker count alone doesn't guarantee staying
 * under a per-minute cap — slides vary in how long the model takes to respond. */
const SLIDE_CONCURRENCY = 4;

/** Backoff schedule for HTTP 429 responses — OpenRouter/provider per-minute rate limits are
 * expected to clear within a minute, so these are retried on their own schedule rather than
 * consuming the single retry a genuine slide failure gets. */
const RATE_LIMIT_BACKOFF_MS = [3000, 8000, 15000, 30000, 30000];

const REQUIRED_TOOLS = ['pdftotext', 'pdftoppm', 'pdfinfo'] as const;

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that the poppler CLI tools this module shells out to are installed:
 * pdftotext (text layer), pdftoppm (slide rendering), pdfinfo (slide count).
 */
export function checkPdfTools(): { ok: boolean; missing: string[] } {
  const missing = REQUIRED_TOOLS.filter(tool => !commandExists(tool));
  return { ok: missing.length === 0, missing };
}

/** Total slide count via pdfinfo — one PDF page is one slide. */
function getSlideCount(pdfPath: string): number {
  const output = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf-8' });
  const match = output.match(/^Pages:\s+(\d+)/m);
  if (!match) {
    throw new Error(`pdfinfo did not report a slide count for ${path.basename(pdfPath)}`);
  }
  return Number(match[1]);
}

/** Text layer for a single slide, in reading order as best pdftotext can determine. */
export function extractSlideText(pdfPath: string, slideNum: number): string {
  return execFileSync(
    'pdftotext',
    ['-f', String(slideNum), '-l', String(slideNum), '-layout', pdfPath, '-'],
    { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
  );
}

/** Renders a single slide to a PNG and returns its bytes. Each slide gets its own subdirectory so
 * pdftoppm's output filename never has to be guessed or risk colliding with a concurrent slide.
 * `dpi` defaults to `DEFAULT_RENDER_DPI`; production and `eval-judge` never override it, `eval-run`'s
 * `--render-dpi` is the only caller that does. */
export function renderSlideImage(pdfPath: string, slideNum: number, tmpDir: string, dpi: number = DEFAULT_RENDER_DPI): Buffer {
  const slideDir = path.join(tmpDir, String(slideNum));
  fs.mkdirSync(slideDir, { recursive: true });
  const prefix = path.join(slideDir, 'slide');
  execFileSync('pdftoppm', [
    '-png',
    '-r', String(dpi),
    '-f', String(slideNum),
    '-l', String(slideNum),
    pdfPath,
    prefix,
  ]);
  const [file] = fs.readdirSync(slideDir);
  if (!file) {
    throw new Error(`pdftoppm produced no image for slide ${slideNum} of ${path.basename(pdfPath)}`);
  }
  return fs.readFileSync(path.join(slideDir, file));
}

/**
 * Clean common LLM artifacts from conversion output
 */
export function cleanConversionArtifacts(text: string): string {
  let cleaned = text;

  // Remove opening code fence
  if (cleaned.startsWith('```markdown')) {
    cleaned = cleaned.replace(/^```markdown\n?/, '');
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\n?/, '');
  }

  // Remove closing code fence
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/\n?```$/, '');
  }

  // Remove introductory lines
  const introPatterns = [
    /^I'll (convert|transcribe) this.*?\n+/i,
    /^Here's the.*?\n+/i,
    /^The (PDF|slide) file.*?\n+/i,
    /^Perfect!.*?\n+/i,
    /^Now I'll.*?\n+/i,
  ];

  for (const pattern of introPatterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Remove concluding summaries (after last ---)
  const lastSeparator = cleaned.lastIndexOf('\n---\n');
  if (lastSeparator !== -1) {
    const afterSeparator = cleaned.substring(lastSeparator + 5);
    if (
      afterSeparator.includes('This markdown preserves') ||
      afterSeparator.includes('Perfect for') ||
      afterSeparator.includes('The content above')
    ) {
      cleaned = cleaned.substring(0, lastSeparator + 5);
    }
  }

  return cleaned.trim();
}

/** Letters-only tokens of 3+ chars, lowercased and stripped of accents — for coverage comparison. */
function normalizeWords(text: string): string[] {
  const stripped = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return stripped.toLowerCase().match(/[a-z]{3,}/g) ?? [];
}

/**
 * Fraction of the slide's text-layer words that also appear somewhere in the transcribed output.
 * A slide with no qualifying text-layer words (typically image-only) has nothing to check and
 * reports full coverage — it's surfaced separately via the image-dominated list instead.
 */
export function computeTextCoverage(slideText: string, slideOutput: string): number {
  const sourceWords = normalizeWords(slideText);
  if (sourceWords.length === 0) return 1;
  const outputWords = new Set(normalizeWords(slideOutput));
  const present = sourceWords.filter(word => outputWords.has(word)).length;
  return present / sourceWords.length;
}

/** True when a slide's text layer is thin enough that its content is likely carried by an image. */
export function isImageDominated(slideText: string): boolean {
  return slideText.trim().length < IMAGE_DOMINATED_CHAR_THRESHOLD;
}

export type SlideCategory =
  | { kind: 'skipped'; slide: number; textPreview: string }
  | { kind: 'flagged'; slide: number; coverage: number }
  | { kind: 'ok' };

/**
 * Decides how a transcribed slide shows up in the conversion report. A slide the model correctly
 * judged to have no teaching content is reported separately as skipped, never as flagged. A slide
 * whose text layer is too thin to compare against (see MIN_COVERAGE_WORDS) is excluded from
 * coverage flagging entirely — its title-only text layer isn't a meaningful baseline.
 */
export function categorizeSlide(slideNum: number, slideText: string, markdown: string): SlideCategory {
  if (markdown.trim() === NO_CONTENT_MARKER) {
    return {
      kind: 'skipped',
      slide: slideNum,
      textPreview: slideText.trim().slice(0, SKIPPED_TEXT_PREVIEW_LENGTH),
    };
  }

  if (normalizeWords(slideText).length < MIN_COVERAGE_WORDS) {
    return { kind: 'ok' };
  }

  const coverage = computeTextCoverage(slideText, markdown);
  if (coverage < MIN_TEXT_COVERAGE) {
    return { kind: 'flagged', slide: slideNum, coverage };
  }

  return { kind: 'ok' };
}

/** sha256 over (image bytes, text layer, rendered prompt, model slug) — changes if any input does. */
export function slideCacheKey(
  imageBytes: Buffer,
  slideText: string,
  prompt: string,
  model: string
): string {
  const hash = crypto.createHash('sha256');
  hash.update(imageBytes);
  hash.update('\u0000');
  hash.update(slideText);
  hash.update('\u0000');
  hash.update(prompt);
  hash.update('\u0000');
  hash.update(model);
  return hash.digest('hex');
}

function slideCachePath(key: string): string {
  return path.join(PDF_SLIDE_CACHE_DIR, `${key}.md`);
}

export function readSlideCache(key: string): string | null {
  const p = slideCachePath(key);
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf-8');
  // A process killed mid-write can leave a truncated or 0-byte cache file; treat it as a miss so
  // the slide gets regenerated rather than served forever. A genuine no-content slide's transcription
  // is always a non-empty marker string, never blank, so this can't shadow a real cached result.
  if (content.trim().length === 0) return null;
  return content;
}

/** Writes via a temp file + rename so a process killed mid-write can never leave a partial file
 * at the final path — readers only ever see the old content or the complete new content. */
export function writeSlideCache(key: string, markdown: string): void {
  fs.mkdirSync(PDF_SLIDE_CACHE_DIR, { recursive: true });
  const finalPath = slideCachePath(key);
  const tmpPath = path.join(PDF_SLIDE_CACHE_DIR, `.${key}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmpPath, markdown);
  fs.renameSync(tmpPath, finalPath);
}

/** An exclusion pass gating each slide before its transcription call (see `slide-content-classifier.ts`).
 * Off by default — `undefined` runs the unchanged transcription-only path. */
export interface ExclusionPassConfig {
  model: string;
  provider?: LlmCallOptions['provider'];
}

/** Sums two LlmUsage objects field by field, for a slide that made both a classifier and a
 * transcription call. `undefined + undefined` stays `undefined` rather than becoming `0`,
 * matching `recordCall`'s convention for a field OpenRouter didn't report. */
function mergeLlmUsage(a: LlmUsage | undefined, b: LlmUsage | undefined): LlmUsage {
  const sum = (x: number | undefined, y: number | undefined): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    promptTokens: sum(a?.promptTokens, b?.promptTokens),
    completionTokens: sum(a?.completionTokens, b?.completionTokens),
    reasoningTokens: sum(a?.reasoningTokens, b?.reasoningTokens),
    costUsd: sum(a?.costUsd, b?.costUsd),
    openrouterCostUsd: sum(a?.openrouterCostUsd, b?.openrouterCostUsd),
    upstreamCostUsd: sum(a?.upstreamCostUsd, b?.upstreamCostUsd),
    isByok: b?.isByok ?? a?.isByok,
  };
}

interface SlideTranscription {
  slideNum: number;
  markdown: string;
  slideText: string;
  /** Undefined for a slide served from the on-disk cache with no exclusion pass in effect (see
   * slideCacheKey) — no call was made. */
  usage?: LlmUsage;
  /** The exclusion-pass classifier's stated reason this slide was dropped — set only when an
   * exclusion pass dropped it; undefined otherwise, including when the transcription model
   * produced the no-content marker on its own with no exclusion pass in effect. */
  exclusionReason?: string;
}

/** Calls callLlm, backing off and retrying on HTTP 429 per RATE_LIMIT_BACKOFF_MS before giving up.
 * Any other error passes straight through. */
async function callLlmWithRateLimitBackoff(slideNum: number, options: LlmCallOptions): Promise<LlmResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callLlm(options);
    } catch (err) {
      const isRateLimit = err instanceof LlmError && err.status === 429;
      if (!isRateLimit || attempt >= RATE_LIMIT_BACKOFF_MS.length) {
        throw err;
      }
      const delay = RATE_LIMIT_BACKOFF_MS[attempt];
      logger.warn(`Slide ${slideNum} rate-limited, backing off ${delay}ms before retrying`, {
        attempt: attempt + 1,
      });
      await sleep(delay);
    }
  }
}

/** The exact per-slide message content `transcribeSlide` sends: the transcription prompt plus a hint
 * built from the slide's text layer, and the rendered slide image as a data URL. Exported so any
 * other caller sends an identical call whatever model it targets. */
export function buildTranscriptionMessageContent(slideText: string, imageBytes: Buffer): LlmContentPart[] {
  const hint = slideText.trim().length > 0
    ? `\n\nText layer extracted from this slide by a PDF text extractor (may be incomplete or out of order — use it as a hint only, never as a ceiling on what to transcribe from the image):\n\n${slideText}`
    : '\n\nNo text layer was extracted from this slide (likely image-only).';

  return [
    { type: 'text', text: TRANSCRIPTION_PROMPT + hint },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` } },
  ];
}

async function transcribeSlide(
  pdfPath: string,
  slideNum: number,
  sessionId: string,
  tmpDir: string,
  exclusionPass?: ExclusionPassConfig
): Promise<SlideTranscription> {
  const slideText = extractSlideText(pdfPath, slideNum);
  const imageBytes = renderSlideImage(pdfPath, slideNum, tmpDir);

  let classifierUsage: LlmUsage | undefined;
  if (exclusionPass) {
    const classification = await classifySlideContent({
      imageBytes, slideText, model: exclusionPass.model, provider: exclusionPass.provider, sessionId,
    });
    classifierUsage = classification.usage;
    if (!classification.teachesLanguage) {
      return { slideNum, markdown: NO_CONTENT_MARKER, slideText, usage: classifierUsage, exclusionReason: classification.reason };
    }
  }

  const key = slideCacheKey(imageBytes, slideText, TRANSCRIPTION_PROMPT, MODELS.pdfConversion);

  const cached = readSlideCache(key);
  if (cached !== null) {
    return { slideNum, markdown: cached, slideText, usage: classifierUsage };
  }

  const content = buildTranscriptionMessageContent(slideText, imageBytes);

  const result = await callLlmWithRateLimitBackoff(slideNum, {
    model: MODELS.pdfConversion,
    maxTokens: SLIDE_TRANSCRIPTION_MAX_TOKENS,
    disableReasoning: true,
    sessionId,
    messages: [{ role: 'user', content }],
  });

  const markdown = cleanConversionArtifacts(result.text);
  writeSlideCache(key, markdown);
  return { slideNum, markdown, slideText, usage: classifierUsage ? mergeLlmUsage(classifierUsage, result.usage) : result.usage };
}

/** Retries a failing slide once before giving up — a slide conversion failure fails the whole run
 * rather than silently dropping that slide's content. */
async function transcribeSlideWithRetry(
  pdfPath: string,
  pdfName: string,
  slideNum: number,
  sessionId: string,
  tmpDir: string,
  exclusionPass?: ExclusionPassConfig
): Promise<SlideTranscription> {
  try {
    return await transcribeSlide(pdfPath, slideNum, sessionId, tmpDir, exclusionPass);
  } catch (err) {
    logger.warn(`Slide ${slideNum} of ${pdfName} failed, retrying once`, {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await transcribeSlide(pdfPath, slideNum, sessionId, tmpDir, exclusionPass);
    } catch (retryErr) {
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(`Failed to convert slide ${slideNum} of ${pdfName} after retry: ${message}`);
    }
  }
}

/** Runs `fn` over `items` with bounded concurrency, returning results in input order regardless
 * of completion order. Once any call fails, remaining workers stop picking up new items — they
 * finish whatever they're already running and then stop — and the function waits for every
 * worker to settle before rethrowing the first error. This keeps a permanent failure from both
 * continuing to bill for slides that will be discarded and racing a caller's cleanup (e.g. a temp
 * directory removed in a `finally`) against work that's still in flight. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let aborted = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    for (;;) {
      if (aborted) return;
      const current = nextIndex++;
      if (current >= items.length) return;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

  if (aborted) {
    throw firstError;
  }

  return results;
}

interface FlaggedSlide {
  slide: number;
  coverage: number;
}

interface SkippedSlide {
  slide: number;
  /** First SKIPPED_TEXT_PREVIEW_LENGTH characters of the slide's text layer, for a quick eyeball check. */
  textPreview: string;
  /** The exclusion-pass classifier's stated reason for dropping this slide — absent when no
   * exclusion pass was in effect (the transcription model produced the marker on its own). */
  reason?: string;
}

interface SlideUsage {
  slide: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
}

interface ConversionReport {
  pdfName: string;
  slideCount: number;
  /** Slides with a real text layer (MIN_COVERAGE_WORDS+ qualifying words) whose transcribed output
   * covers less than MIN_TEXT_COVERAGE of it — worth a human look. */
  flaggedSlides: FlaggedSlide[];
  /** Slides the model correctly judged to have no teaching content (NO_CONTENT_MARKER output). */
  skippedSlides: SkippedSlide[];
  /** Slides whose text layer is under IMAGE_DOMINATED_CHAR_THRESHOLD characters. */
  imageDominatedSlides: number[];
  /** Usage for each slide that actually called the model — a slide served from the on-disk cache
   * (see slideCacheKey) is absent here, since no call was made and it cost nothing this run. */
  slideUsage: SlideUsage[];
  /** Sum of every entry in slideUsage. */
  totalUsage: UsageTotals;
  /** sha256 (16 hex) of the rendered transcription prompt used for this run. */
  promptHash: string;
}

export interface PdfConversionResult {
  markdown: string;
  report: ConversionReport;
}

/** Builds the report's per-slide usage list and run total from every transcribed slide — a slide
 * with no `usage` (served from the on-disk cache) contributes to neither. */
export function buildSlideUsage(slides: Array<Pick<SlideTranscription, 'slideNum' | 'usage'>>): {
  slideUsage: SlideUsage[];
  totalUsage: UsageTotals;
} {
  const slideUsage: SlideUsage[] = [];
  const totalUsage = emptyUsageTotals();

  for (const { slideNum, usage } of slides) {
    if (!usage) continue;
    recordCall(totalUsage, usage);
    slideUsage.push({
      slide: slideNum,
      prompt_tokens: usage.promptTokens ?? null,
      completion_tokens: usage.completionTokens ?? null,
      reasoning_tokens: usage.reasoningTokens ?? null,
      cost_usd: usage.costUsd ?? null,
    });
  }

  return { slideUsage, totalUsage };
}

/**
 * Convert a PDF to markdown by transcribing every slide with a vision model.
 *
 * Each slide is rendered to an image and paired with its (possibly empty) text layer as a hint;
 * both go to MODELS.pdfConversion. Output is cached per slide on disk (see slideCacheKey) — a rerun
 * with the same slide image, text layer, prompt, and model reuses the cached transcription instead
 * of calling the model again, whether or not the caller is force-reconverting the combined
 * markdown file for this PDF.
 *
 * `exclusionPass`, when given, gates each slide through a separate teaching-content classifier
 * (see `slide-content-classifier.ts`) before the transcription call: a slide it judges not to
 * teach the course language gets the no-content marker directly, with no transcription call made.
 * Off by default, leaving the transcription-only path unchanged.
 */
export async function convertPdfToMarkdown(
  pdfPath: string,
  pdfName: string,
  sessionId: string,
  exclusionPass?: ExclusionPassConfig
): Promise<PdfConversionResult> {
  const slideCount = getSlideCount(pdfPath);
  console.log(`  📝 Transcribing ${pdfName} (${slideCount} slide${slideCount === 1 ? '' : 's'}) with vision model...`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-slides-'));
  try {
    const slideNumbers = Array.from({ length: slideCount }, (_, i) => i + 1);
    let completed = 0;

    const slides = await mapWithConcurrency(slideNumbers, SLIDE_CONCURRENCY, async (slideNum) => {
      const slide = await transcribeSlideWithRetry(pdfPath, pdfName, slideNum, sessionId, tmpDir, exclusionPass);
      completed += 1;
      console.log(`     Slide ${completed}/${slideCount} done (slide ${slideNum})`);
      return slide;
    });

    const flaggedSlides: FlaggedSlide[] = [];
    const skippedSlides: SkippedSlide[] = [];
    const imageDominatedSlides: number[] = [];
    const markdownSlides: string[] = [];

    for (const { slideNum, markdown, slideText, exclusionReason } of slides) {
      markdownSlides.push(`<!-- slide ${slideNum} -->\n\n${markdown}`);

      if (isImageDominated(slideText)) {
        imageDominatedSlides.push(slideNum);
      }

      const category = categorizeSlide(slideNum, slideText, markdown);
      if (category.kind === 'skipped') {
        skippedSlides.push({
          slide: category.slide,
          textPreview: category.textPreview,
          ...(exclusionReason !== undefined ? { reason: exclusionReason } : {}),
        });
      } else if (category.kind === 'flagged') {
        flaggedSlides.push({ slide: category.slide, coverage: category.coverage });
      }
    }

    const { slideUsage, totalUsage } = buildSlideUsage(slides);
    const report: ConversionReport = {
      pdfName, slideCount, flaggedSlides, skippedSlides, imageDominatedSlides, slideUsage, totalUsage,
      promptHash: TRANSCRIPTION_PROMPT_HASH,
    };
    console.log(
      `  ✅ Transcribed ${pdfName}: ${flaggedSlides.length} slide(s) below ${Math.round(MIN_TEXT_COVERAGE * 100)}% text coverage, ${skippedSlides.length} correctly skipped (no teaching content), ${imageDominatedSlides.length} image-dominated slide(s)`
    );
    if (totalUsage.calls > 0) {
      console.log(`  ${formatUsageSummary(totalUsage)}`);
    }

    return { markdown: markdownSlides.join('\n\n'), report };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
