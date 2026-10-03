import type { MetadataRoute } from 'next';

/**
 * Crawlers that collect pages for model training, by the user-agent token each vendor documents.
 * Only crawlers that honor robots.txt are affected; the X-Robots-Tag header in next.config.ts is
 * what keeps the site out of search results, and search engines are allowed to crawl so they see it.
 */
export const TRAINING_CRAWLERS = [
  'GPTBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'Claude-Web',
  'Google-Extended',
  'CCBot',
  'Bytespider',
  'PerplexityBot',
  'Applebot-Extended',
  'Meta-ExternalAgent',
  'Meta-ExternalFetcher',
  'cohere-ai',
  'Amazonbot',
  'Diffbot',
  'omgili',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: TRAINING_CRAWLERS, disallow: '/' },
      { userAgent: '*', allow: '/', disallow: '/api/' },
    ],
  };
}
