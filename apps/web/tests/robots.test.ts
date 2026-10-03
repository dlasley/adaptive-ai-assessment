import { describe, it, expect, vi, afterEach } from 'vitest';
import robots, { TRAINING_CRAWLERS } from '../src/app/robots';
import { metadata as siteMetadata } from '../src/app/(site)/layout';
import { metadata as bareMetadata } from '../src/app/(bare)/layout';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('search and training-crawler opt-out', () => {
  it('sends X-Robots-Tag noindex on every response', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { default: nextConfig } = await import('../next.config');
    const headerGroups = await nextConfig.headers!();
    const catchAll = headerGroups.find((group) => group.source === '/:path*');
    const header = catchAll?.headers.find((h) => h.key === 'X-Robots-Tag');

    expect(header?.value.split(', ').sort()).toEqual(['noarchive', 'nofollow', 'noindex']);
  });

  it('disallows every listed training crawler and lets other crawlers read pages', () => {
    const { rules } = robots();
    const list = Array.isArray(rules) ? rules : [rules];
    const training = list.find((rule) => Array.isArray(rule.userAgent));
    const everyone = list.find((rule) => rule.userAgent === '*');

    expect(training?.userAgent).toEqual(TRAINING_CRAWLERS);
    expect(training?.disallow).toBe('/');
    expect(everyone?.allow).toBe('/');
    expect(everyone?.disallow).toBe('/api/');
  });

  it('names the documented crawler tokens of the major model vendors', () => {
    for (const token of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot', 'Bytespider', 'PerplexityBot', 'Applebot-Extended', 'Meta-ExternalAgent']) {
      expect(TRAINING_CRAWLERS).toContain(token);
    }
  });

  it('marks both root layouts noindex and nofollow in their metadata', () => {
    for (const metadata of [siteMetadata, bareMetadata]) {
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
  });
});
