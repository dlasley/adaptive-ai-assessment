import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmCallOptions, LlmContentPart, LlmResult } from '@adaptive/shared/llm';

/**
 * Exercises `convertPdfToMarkdown`'s `exclusionPass` gate end to end, without a real PDF, poppler
 * binary, or network call. `execFileSync` is stubbed per-tool (`pdfinfo`/`pdftotext`/`pdftoppm`):
 * the `pdftoppm` branch writes a real file to the temp slide directory it's given, so the
 * production code's own (unmocked) `fs.readdirSync`/`fs.readFileSync` in `renderSlideImage` pick it
 * up exactly as they would a real render. `callLlm` is stubbed to route on `jsonMode` (only the
 * classifier call sets it) so one stub serves both the classify and, for a kept slide, the
 * transcription call.
 */

const { execFileSyncMock, callLlmMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  callLlmMock: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: execFileSyncMock,
}));

vi.mock('@adaptive/shared/llm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@adaptive/shared/llm')>()),
  callLlm: callLlmMock,
}));

import { convertPdfToMarkdown, renderSlideImage, NO_CONTENT_MARKER, slideCacheKey, TRANSCRIPTION_PROMPT } from '../src/lib/pdf-conversion';
import { PDF_SLIDE_CACHE_DIR } from '../src/lib/paths';
import { MODELS } from '../src/lib/pipeline-config';

function textPartOf(opts: LlmCallOptions): string {
  const content = opts.messages[0].content;
  const part = (Array.isArray(content) ? content : []).find((c: LlmContentPart) => c.type === 'text');
  return part && part.type === 'text' ? part.text : '';
}

describe('convertPdfToMarkdown — exclusionPass', () => {
  // The kept slide (slide 1) reaches the real writeSlideCache, keyed on its (fake) rendered image
  // bytes, text layer, prompt, and model — this key can never collide with a real slide's cache
  // entry, but the file still needs cleaning up after the test writes it.
  const keptSlideCacheKey = slideCacheKey(Buffer.from('fake-png-bytes'), 'keep-me vocabulary', TRANSCRIPTION_PROMPT, MODELS.pdfConversion);
  const keptSlideCachePath = path.join(PDF_SLIDE_CACHE_DIR, `${keptSlideCacheKey}.md`);

  afterEach(() => {
    execFileSyncMock.mockReset();
    callLlmMock.mockReset();
    fs.rmSync(keptSlideCachePath, { force: true });
  });

  it('gates a two-slide PDF: the dropped slide gets the marker and a skipped-with-reason entry, the kept slide is transcribed', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === 'pdfinfo') return 'Pages:          2\n';
      if (cmd === 'pdftotext') {
        const slideArg = args[1]; // ['-f', slideNum, '-l', slideNum, '-layout', pdfPath, '-']
        return slideArg === '1' ? 'keep-me vocabulary' : 'drop-me classroom rules';
      }
      if (cmd === 'pdftoppm') {
        const prefix = args[args.length - 1];
        fs.mkdirSync(path.dirname(prefix), { recursive: true });
        fs.writeFileSync(`${prefix}-1.png`, Buffer.from('fake-png-bytes'));
        return '';
      }
      throw new Error(`unexpected execFileSync call: ${cmd} ${args.join(' ')}`);
    });

    callLlmMock.mockImplementation(async (opts: LlmCallOptions): Promise<LlmResult> => {
      const text = textPartOf(opts);
      if (opts.jsonMode) {
        const verdict = text.includes('drop-me')
          ? { teaches_language: false, reason: 'Classroom rules, no vocabulary or grammar.' }
          : { teaches_language: true, reason: 'Vocabulary list.' };
        return { text: JSON.stringify(verdict), model: opts.model, raw: {} };
      }
      return { text: 'Transcribed vocabulary list', model: opts.model, raw: {} };
    });

    const { markdown, report } = await convertPdfToMarkdown(
      '/fake/unit.pdf',
      'unit.pdf',
      'session-1',
      { model: 'anthropic/claude-sonnet-5' }
    );

    expect(markdown).toContain('Transcribed vocabulary list');
    expect(markdown).toContain(NO_CONTENT_MARKER);

    expect(report.skippedSlides).toEqual([
      { slide: 2, textPreview: 'drop-me classroom rules', reason: 'Classroom rules, no vocabulary or grammar.' },
    ]);

    // Slide 1: classify (jsonMode) + transcribe (no jsonMode). Slide 2: classify only.
    const jsonModeCalls = callLlmMock.mock.calls.filter(([opts]) => (opts as LlmCallOptions).jsonMode);
    const plainCalls = callLlmMock.mock.calls.filter(([opts]) => !(opts as LlmCallOptions).jsonMode);
    expect(jsonModeCalls).toHaveLength(2);
    expect(plainCalls).toHaveLength(1);
  });
});

describe('renderSlideImage: dpi argument', () => {
  let tmpDir: string;

  function stubPdftoppm() {
    execFileSyncMock.mockImplementation((cmd: string, args: string[] = []) => {
      const prefix = args[args.length - 1];
      fs.mkdirSync(path.dirname(prefix), { recursive: true });
      fs.writeFileSync(`${prefix}-1.png`, Buffer.from('fake-png-bytes'));
      return '';
    });
  }

  function dpiArgOf(): string {
    const [, args] = execFileSyncMock.mock.calls[0] as [string, string[]];
    return args[args.indexOf('-r') + 1];
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-dpi-test-'));
  });

  afterEach(() => {
    execFileSyncMock.mockReset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes -r 120 to pdftoppm by default', () => {
    stubPdftoppm();
    renderSlideImage('/fake/unit.pdf', 1, tmpDir);
    expect(dpiArgOf()).toBe('120');
  });

  it('passes the given dpi to pdftoppm', () => {
    stubPdftoppm();
    renderSlideImage('/fake/unit.pdf', 1, tmpDir, 300);
    expect(dpiArgOf()).toBe('300');
  });
});
