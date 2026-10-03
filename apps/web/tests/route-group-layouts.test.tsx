import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesNamingSecrets, moduleGraph, webSrc } from './module-graph';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

const { default: SiteLayout } = await import('@/app/(site)/layout');
const { default: BareLayout } = await import('@/app/(bare)/layout');
const { default: ChallengePage } = await import('@/app/(bare)/challenge/page');
const { ChallengeTokenHandoff } = await import('@/components/challenge-token-handoff');

const appDir = path.join(webSrc, 'app');

// The props Next.js passes a page for /challenge?siteKey=query-site-key. The page declares none,
// so the cast lets a test hand them over anyway, the way the router would.
const queryProps = { params: {}, searchParams: { siteKey: 'query-site-key' } };
const ChallengePageWithRouteProps = ChallengePage as unknown as (props: typeof queryProps) => ReactElement;

function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement(node.props.children, type);
}

function filesNamed(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'api' ? [] : filesNamed(full, name);
    return entry.name === name ? [path.relative(appDir, full).split(path.sep).join('/')] : [];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('root layouts', () => {
  it('has exactly two root layouts, one per route group', () => {
    expect(filesNamed(appDir, 'layout.tsx').sort()).toEqual(['(bare)/layout.tsx', '(site)/layout.tsx']);
  });

  it('serves every page from the site group except the challenge page', () => {
    const pages = filesNamed(appDir, 'page.tsx');
    expect(pages).toContain('(bare)/challenge/page.tsx');
    expect(pages.filter((p) => p !== '(bare)/challenge/page.tsx' && !p.startsWith('(site)/'))).toEqual([]);
    expect(pages.filter((p) => p.startsWith('(site)/')).sort()).toEqual([
      '(site)/admin/login/page.tsx',
      '(site)/admin/page.tsx',
      '(site)/page.tsx',
      '(site)/progress/page.tsx',
      '(site)/quiz/[unitId]/page.tsx',
      '(site)/resources/page.tsx',
    ]);
  });

  it('the site layout renders the header and navigation around the page', () => {
    const html = renderToStaticMarkup(<SiteLayout><p>page body</p></SiteLayout>);

    expect(html).toMatch(/<header[\s>]/);
    expect(html).toMatch(/<nav[\s>]/);
    expect(html).toContain('page body');
  });

  it('the bare layout renders the page with no header and no navigation', () => {
    const html = renderToStaticMarkup(<BareLayout><p>page body</p></BareLayout>);

    expect(html).toBe('<html lang="en"><head></head><body class="antialiased"><p>page body</p></body></html>');
    expect(html).not.toMatch(/<header[\s>]/);
    expect(html).not.toMatch(/<nav[\s>]/);
  });
});

describe('challenge page', () => {
  it('takes no route props, so it reads no query parameters', () => {
    expect(ChallengePage.length).toBe(0);
  });

  it('renders the challenge with the site key from the server environment', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'test-site-key');

    const html = renderToStaticMarkup(<ChallengePage />);

    expect(html).toContain('Additional verification is required to continue.');
    expect(html).not.toContain('Verification is not available');
  });

  it('says verification is unavailable when no site key is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', undefined);

    const html = renderToStaticMarkup(<ChallengePage />);

    expect(html).toContain('Verification is not available right now.');
  });

  it('hands the challenge the configured site key, not a siteKey query parameter', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'test-site-key');

    const handoff = findElement(ChallengePageWithRouteProps(queryProps), ChallengeTokenHandoff);

    expect(handoff?.props.siteKey).toBe('test-site-key');
  });

  it('stays unavailable when only a siteKey query parameter supplies a key', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', undefined);

    const html = renderToStaticMarkup(<ChallengePageWithRouteProps {...queryProps} />);

    expect(html).toContain('Verification is not available right now.');
  });

  it('never reaches a module that reads the OpenRouter key or the Turnstile secret', () => {
    const graph = moduleGraph(path.join(appDir, '(bare)/challenge/page.tsx'));
    expect(graph.map((f) => path.relative(webSrc, f))).toContain(path.join('components', 'turnstile-widget.tsx'));
    expect(filesNamingSecrets(graph)).toEqual([]);
  });
});
