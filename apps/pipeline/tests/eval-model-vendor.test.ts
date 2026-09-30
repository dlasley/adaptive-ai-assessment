import { describe, expect, it } from 'vitest';
import { vendorForModelSlug } from '../src/lib/eval/model-vendor';

describe('vendorForModelSlug', () => {
  it('reads the vendor from an OpenRouter-style slug', () => {
    expect(vendorForModelSlug('openai/gpt-5-mini')).toBe('openai');
  });

  it('maps a direct slug whose name has a known vendor', () => {
    expect(vendorForModelSlug('direct:mistral-ocr-4-1')).toBe('mistralai');
  });

  it('returns null for a direct slug whose name has no mapping', () => {
    expect(vendorForModelSlug('direct:unknown-thing-1')).toBeNull();
  });

  it('returns null for a slug without a slash', () => {
    expect(vendorForModelSlug('nobody-not-registered')).toBeNull();
  });

  it('maps a direct slug with no hyphen using the whole name as the leading token', () => {
    expect(vendorForModelSlug('direct:mistral')).toBe('mistralai');
  });

  it('returns null for a slug that starts with a slash', () => {
    expect(vendorForModelSlug('/gpt-5-mini')).toBeNull();
  });
});
