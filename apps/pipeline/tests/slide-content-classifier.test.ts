import { describe, expect, it, vi } from 'vitest';
import {
  buildClassifyMessageContent,
  classifySlideContent,
  parseSlideClassification,
  SlideClassificationParseError,
} from '../src/lib/slide-content-classifier';
import type { LlmResult } from '@adaptive/shared/llm';

describe('parseSlideClassification', () => {
  it('parses a true verdict', () => {
    const parsed = parseSlideClassification('{"teaches_language": true, "reason": "Vocabulary list."}');
    expect(parsed).toEqual({ teachesLanguage: true, reason: 'Vocabulary list.' });
  });

  it('parses a false verdict', () => {
    const parsed = parseSlideClassification('{"teaches_language": false, "reason": "Classroom rules only."}');
    expect(parsed).toEqual({ teachesLanguage: false, reason: 'Classroom rules only.' });
  });

  it('strips a code fence the model added despite instructions not to', () => {
    const parsed = parseSlideClassification('```json\n{"teaches_language": true, "reason": "Grammar table."}\n```');
    expect(parsed).toEqual({ teachesLanguage: true, reason: 'Grammar table.' });
  });

  it('throws on malformed JSON, never silently defaulting to true', () => {
    expect(() => parseSlideClassification('not json at all')).toThrow(SlideClassificationParseError);
  });

  it('throws when teaches_language is missing', () => {
    expect(() => parseSlideClassification('{"reason": "no verdict field"}')).toThrow(SlideClassificationParseError);
  });

  it('throws when teaches_language is not a boolean', () => {
    expect(() => parseSlideClassification('{"teaches_language": "true", "reason": "wrong type"}')).toThrow(
      SlideClassificationParseError
    );
  });

  it('throws when reason is missing or blank', () => {
    expect(() => parseSlideClassification('{"teaches_language": true, "reason": ""}')).toThrow(
      SlideClassificationParseError
    );
    expect(() => parseSlideClassification('{"teaches_language": true}')).toThrow(SlideClassificationParseError);
  });
});

describe('buildClassifyMessageContent', () => {
  it('includes the text-layer hint and the image as a data URL', () => {
    const content = buildClassifyMessageContent('Bonjour', Buffer.from('fake-bytes'));
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect((content[0] as { type: 'text'; text: string }).text).toContain('Bonjour');
    expect(content[1]).toMatchObject({ type: 'image_url' });
  });

  it('notes an absent text layer instead of an empty hint', () => {
    const content = buildClassifyMessageContent('', Buffer.from('fake-bytes'));
    expect((content[0] as { type: 'text'; text: string }).text).toContain('No text layer was extracted');
  });
});

describe('classifySlideContent', () => {
  function stubResult(text: string): LlmResult {
    return { text, model: 'stub-model', raw: {}, usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.001 } };
  }

  it('sends jsonMode and reasoning disabled by default, and returns the parsed verdict plus usage', async () => {
    const callLlmFn = vi.fn(async () => stubResult('{"teaches_language": false, "reason": "Study tips only."}'));

    const result = await classifySlideContent({
      imageBytes: Buffer.from('fake-bytes'),
      slideText: 'Pourquoi apprendre le français?',
      model: 'anthropic/claude-sonnet-5',
      callLlmFn,
    });

    expect(result).toEqual({ teachesLanguage: false, reason: 'Study tips only.', usage: { promptTokens: 100, completionTokens: 20, costUsd: 0.001 } });
    expect(callLlmFn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-sonnet-5',
        jsonMode: true,
        reasoning: { enabled: false },
      })
    );
  });

  it('propagates a parse failure rather than defaulting to a verdict', async () => {
    const callLlmFn = vi.fn(async () => stubResult('not valid json'));

    await expect(
      classifySlideContent({
        imageBytes: Buffer.from('fake-bytes'),
        slideText: 'text',
        model: 'anthropic/claude-sonnet-5',
        callLlmFn,
      })
    ).rejects.toThrow(SlideClassificationParseError);
  });
});
