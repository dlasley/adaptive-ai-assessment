import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSlideUsage,
  buildTranscriptionMessageContent,
  categorizeSlide,
  computeTextCoverage,
  IMAGE_DOMINATED_CHAR_THRESHOLD,
  isImageDominated,
  mapWithConcurrency,
  MIN_COVERAGE_WORDS,
  MIN_TEXT_COVERAGE,
  slideCacheKey,
  readSlideCache,
  TRANSCRIPTION_PROMPT,
  writeSlideCache,
} from '../src/lib/pdf-conversion';
import { PDF_SLIDE_CACHE_DIR } from '../src/lib/paths';

describe('computeTextCoverage', () => {
  it('returns 1 when every text-layer word appears in the output', () => {
    const coverage = computeTextCoverage(
      'Les dates importantes du calendrier',
      '## Dates\n\nLes dates importantes du calendrier français'
    );
    expect(coverage).toBe(1);
  });

  it('returns a fraction when only some text-layer words survive', () => {
    // 4 qualifying words (3+ letters): "les" "dates" "importantes" "calendrier" — "du" is 2 letters, dropped
    const coverage = computeTextCoverage('Les dates importantes du calendrier', '## Dates');
    expect(coverage).toBeCloseTo(1 / 4);
  });

  it('is case- and accent-insensitive', () => {
    const coverage = computeTextCoverage('LES ÉLÈVES étudient', 'les eleves etudient');
    expect(coverage).toBe(1);
  });

  it('ignores tokens under 3 letters on both sides', () => {
    // "du", "le" are 2-letter and excluded from the word set entirely
    const coverage = computeTextCoverage('du le chat', 'un chat');
    expect(coverage).toBe(1);
  });

  it('returns 1 for a text layer with no qualifying words (image-only slide)', () => {
    const coverage = computeTextCoverage('12 3 . -', 'Full transcription of the slide content.');
    expect(coverage).toBe(1);
  });

  it('returns 0 when none of the text-layer words appear in the output', () => {
    const coverage = computeTextCoverage('bonjour monde', 'completely different content here');
    expect(coverage).toBe(0);
  });

  it('flags a slide whose output drops most of the text layer', () => {
    const slideText = 'les dates importantes du calendrier scolaire français';
    const output = '## Dates';
    expect(computeTextCoverage(slideText, output)).toBeLessThan(MIN_TEXT_COVERAGE);
  });
});

describe('categorizeSlide', () => {
  it('reports the no-content marker as skipped, never flagged', () => {
    const slideText = 'Classroom rules: no phones, no food, be on time. Respect your classmates.';
    const result = categorizeSlide(2, slideText, '<!-- no teaching content -->');
    expect(result).toEqual({
      kind: 'skipped',
      slide: 2,
      textPreview: slideText.slice(0, 80),
    });
  });

  it('truncates the skipped-slide text preview to 80 characters', () => {
    const slideText = 'x'.repeat(200);
    const result = categorizeSlide(2, slideText, '<!-- no teaching content -->');
    expect(result.kind).toBe('skipped');
    expect(result.kind === 'skipped' && result.textPreview).toHaveLength(80);
  });

  it('recognizes the no-content marker regardless of surrounding whitespace', () => {
    const result = categorizeSlide(2, 'some text', '  <!-- no teaching content -->  \n');
    expect(result.kind).toBe('skipped');
  });

  it('does not flag a slide whose text layer is just a title (below MIN_COVERAGE_WORDS)', () => {
    // "carnet" and "bord" are the only 2 qualifying words, well under MIN_COVERAGE_WORDS
    const result = categorizeSlide(15, 'Carnet de bord (8)', '## Carnet de bord\n\nFull lesson content here.');
    expect(result).toEqual({ kind: 'ok' });
  });

  it('flags a slide with a real text layer whose output drops most of it', () => {
    const slideText = 'les dates importantes du calendrier scolaire français';
    expect(normalizeWordCountFor(slideText)).toBeGreaterThanOrEqual(MIN_COVERAGE_WORDS);
    const result = categorizeSlide(90, slideText, '## Dates');
    expect(result).toEqual({ kind: 'flagged', slide: 90, coverage: expect.any(Number) });
    expect(result.kind === 'flagged' && result.coverage).toBeLessThan(MIN_TEXT_COVERAGE);
  });

  it('does not flag a slide with a real text layer whose output covers it well', () => {
    const slideText = 'les dates importantes du calendrier scolaire français';
    const output = '## Dates\n\nLes dates importantes du calendrier scolaire français sont utiles.';
    const result = categorizeSlide(90, slideText, output);
    expect(result).toEqual({ kind: 'ok' });
  });
});

// Local helper so the MIN_COVERAGE_WORDS boundary test above doesn't hardcode a word count that
// would silently drift out of sync with normalizeWords' own tokenization rules.
function normalizeWordCountFor(text: string): number {
  return (text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]{3,}/g) ?? []).length;
}

describe('isImageDominated', () => {
  it('is true for a text layer shorter than the threshold', () => {
    expect(isImageDominated('Dates')).toBe(true);
    expect('Dates'.length).toBeLessThan(IMAGE_DOMINATED_CHAR_THRESHOLD);
  });

  it('is false for a text layer at or over the threshold', () => {
    expect(isImageDominated('x'.repeat(IMAGE_DOMINATED_CHAR_THRESHOLD))).toBe(false);
  });

  it('trims whitespace before measuring length', () => {
    const padded = `   ${'x'.repeat(IMAGE_DOMINATED_CHAR_THRESHOLD - 1)}   `;
    expect(isImageDominated(padded)).toBe(true);
  });
});

describe('slideCacheKey', () => {
  const image = Buffer.from('fake-png-bytes');
  const text = 'slide text layer';
  const prompt = 'rendered prompt';
  const model = 'anthropic/claude-sonnet-5';

  it('is deterministic for identical inputs', () => {
    expect(slideCacheKey(image, text, prompt, model)).toBe(slideCacheKey(image, text, prompt, model));
  });

  it('changes when the image bytes change', () => {
    const other = Buffer.from('different-png-bytes');
    expect(slideCacheKey(image, text, prompt, model)).not.toBe(slideCacheKey(other, text, prompt, model));
  });

  it('changes when the text layer changes', () => {
    expect(slideCacheKey(image, text, prompt, model)).not.toBe(
      slideCacheKey(image, 'different text layer', prompt, model)
    );
  });

  it('changes when the prompt changes', () => {
    expect(slideCacheKey(image, text, prompt, model)).not.toBe(
      slideCacheKey(image, text, 'different prompt', model)
    );
  });

  it('changes when the model changes', () => {
    expect(slideCacheKey(image, text, prompt, model)).not.toBe(
      slideCacheKey(image, text, prompt, 'anthropic/claude-haiku-4.5')
    );
  });

  it('does not collide across a field boundary that shifts without changing concatenation', () => {
    // 'ab' + 'c' vs 'a' + 'bc': naive concatenation would hash identically; the null-byte
    // separator between fields keeps them distinct.
    const keyA = slideCacheKey(Buffer.from('ab'), 'c', prompt, model);
    const keyB = slideCacheKey(Buffer.from('a'), 'bc', prompt, model);
    expect(keyA).not.toBe(keyB);
  });
});

describe('readSlideCache / writeSlideCache', () => {
  // A key namespaced to this test run, so it can never collide with a real slide's cache entry
  // and is easy to identify for cleanup.
  const testKey = `test-fixture-${crypto.randomUUID()}`;
  const cachePath = path.join(PDF_SLIDE_CACHE_DIR, `${testKey}.md`);

  afterEach(() => {
    fs.rmSync(cachePath, { force: true });
  });

  it('round-trips written content', () => {
    writeSlideCache(testKey, '## Dates\n\nSome transcribed content.');
    expect(readSlideCache(testKey)).toBe('## Dates\n\nSome transcribed content.');
  });

  it('treats a missing entry as a cache miss', () => {
    expect(readSlideCache(testKey)).toBeNull();
  });

  it('treats a 0-byte cache file as a miss rather than serving it', () => {
    fs.mkdirSync(PDF_SLIDE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, '');
    expect(readSlideCache(testKey)).toBeNull();
  });

  it('treats a whitespace-only cache file as a miss', () => {
    fs.mkdirSync(PDF_SLIDE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, '   \n  ');
    expect(readSlideCache(testKey)).toBeNull();
  });

  it('does not leave a stray temp file behind after writing', () => {
    writeSlideCache(testKey, 'content');
    const entries = fs.readdirSync(PDF_SLIDE_CACHE_DIR).filter(name => name.includes(testKey));
    expect(entries).toEqual([`${testKey}.md`]);
  });

  it('writes via rename so a reader never observes a partial file', () => {
    // writeFileSync + renameSync means the only two possible observed states are "absent" and
    // "complete" — verified indirectly here by checking the temp-file naming convention rename
    // depends on (a dotfile prefix, distinct from the final `${key}.md` path).
    writeSlideCache(testKey, 'content');
    const finalExists = fs.existsSync(cachePath);
    const tmpLeftover = fs.readdirSync(PDF_SLIDE_CACHE_DIR).some(name => name.startsWith(`.${testKey}.`));
    expect(finalExists).toBe(true);
    expect(tmpLeftover).toBe(false);
  });
});

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Items with a smaller value resolve slower, so completion order is reversed
    // relative to input order — output order must still match input order.
    const items = [5, 4, 3, 2, 1, 5, 4, 3, 2, 1];
    const completionOrder: number[] = [];

    const results = await mapWithConcurrency(items, 4, async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, item));
      completionOrder.push(index);
      return item * 10;
    });

    expect(results).toEqual(items.map(item => item * 10));
    // Sanity check that concurrency actually reordered completions (not a false-positive pass).
    expect(completionOrder).not.toEqual(items.map((_, i) => i));
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('propagates a worker error', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('slide 2 failed');
        return item;
      })
    ).rejects.toThrow('slide 2 failed');
  });

  it('handles an empty item list', async () => {
    const results = await mapWithConcurrency([], 4, async (item) => item);
    expect(results).toEqual([]);
  });

  it('stops starting new items after a failure and waits for in-flight work to settle', async () => {
    vi.useFakeTimers();
    try {
      const started: number[] = [];
      const finished: number[] = [];
      const items = [1, 2, 3, 4, 5, 6];

      const promise = mapWithConcurrency(items, 2, async (item) => {
        started.push(item);
        if (item === 2) {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw new Error('slide 2 failed');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        finished.push(item);
        return item;
      });

      let settled = false;
      promise.catch(() => {}).finally(() => {
        settled = true;
      });

      // Item 2 (the failing one) throws at t=10 — item 1 is still mid-flight (needs 50ms total).
      await vi.advanceTimersByTimeAsync(10);
      expect(started).toEqual([1, 2]); // exactly the two initially-dispatched items — nothing past the failure
      expect(settled).toBe(false); // item 1's worker hasn't settled yet

      // Item 1 finishes at t=50; the worker pool should stop there rather than picking up item 3.
      await vi.advanceTimersByTimeAsync(40);
      expect(finished).toEqual([1]);
      expect(started).toEqual([1, 2]); // still no item 3 — confirms the abort flag, not just timing luck
      expect(settled).toBe(true);

      await expect(promise).rejects.toThrow('slide 2 failed');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildSlideUsage', () => {
  it('lists usage per slide and sums it into a run total', () => {
    const { slideUsage, totalUsage } = buildSlideUsage([
      { slideNum: 1, usage: { promptTokens: 5000, completionTokens: 200, costUsd: 0.01 } },
      { slideNum: 2, usage: { promptTokens: 5200, completionTokens: 180, costUsd: 0.011 } },
    ]);

    expect(slideUsage).toEqual([
      { slide: 1, prompt_tokens: 5000, completion_tokens: 200, reasoning_tokens: null, cost_usd: 0.01 },
      { slide: 2, prompt_tokens: 5200, completion_tokens: 180, reasoning_tokens: null, cost_usd: 0.011 },
    ]);
    expect(totalUsage.calls).toBe(2);
    expect(totalUsage.prompt_tokens).toBe(10200);
    expect(totalUsage.completion_tokens).toBe(380);
    expect(totalUsage.cost_usd).toBeCloseTo(0.021, 10);
  });

  it('excludes a cache-served slide (no usage) from both the list and the total', () => {
    const { slideUsage, totalUsage } = buildSlideUsage([
      { slideNum: 1, usage: { promptTokens: 5000, completionTokens: 200, costUsd: 0.01 } },
      { slideNum: 2, usage: undefined },
    ]);

    expect(slideUsage.map((s) => s.slide)).toEqual([1]);
    expect(totalUsage.calls).toBe(1);
  });

  it('returns an empty list and zeroed total when every slide was cache-served', () => {
    const { slideUsage, totalUsage } = buildSlideUsage([{ slideNum: 1, usage: undefined }]);

    expect(slideUsage).toEqual([]);
    expect(totalUsage.calls).toBe(0);
  });
});

describe('buildTranscriptionMessageContent', () => {
  // Exported so any other caller of the transcription prompt sends the exact production
  // call for any model it tests — this locks the shape down so a refactor of transcribeSlide
  // can't silently drift the two apart.
  it('builds a two-part message: the transcription prompt plus hint, then the slide image', () => {
    const imageBytes = Buffer.from('fake-png-bytes');
    const content = buildTranscriptionMessageContent('Les dates importantes', imageBytes);

    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: 'text',
      text: expect.stringContaining(TRANSCRIPTION_PROMPT),
    });
    expect((content[0] as { text: string }).text).toContain('Les dates importantes');
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${imageBytes.toString('base64')}` },
    });
  });

  it('notes an image-only slide distinctly from an empty text layer with content', () => {
    const content = buildTranscriptionMessageContent('', Buffer.from('x'));
    expect((content[0] as { text: string }).text).toContain('No text layer was extracted');
  });

  it('never lets the text-layer hint replace the fixed prompt — the prompt text is always the prefix', () => {
    const content = buildTranscriptionMessageContent('some text', Buffer.from('x'));
    expect((content[0] as { text: string }).text.startsWith(TRANSCRIPTION_PROMPT)).toBe(true);
  });
});
