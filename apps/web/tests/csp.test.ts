import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function getScriptSrcDirective(nodeEnv: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  const { default: nextConfig } = await import('../next.config');
  const headerGroups = await nextConfig.headers!();
  const csp = headerGroups[0].headers.find((h) => h.key === 'Content-Security-Policy');
  if (!csp) throw new Error('Content-Security-Policy header missing');
  const directive = csp.value.split('; ').find((d) => d.startsWith('script-src'));
  if (!directive) throw new Error('script-src directive missing');
  return directive;
}

describe('CSP script-src', () => {
  it('drops unsafe-eval in production, keeps unsafe-inline and Turnstile', async () => {
    const directive = await getScriptSrcDirective('production');
    expect(directive).not.toContain('unsafe-eval');
    expect(directive).toContain("'unsafe-inline'");
    expect(directive).toContain('https://challenges.cloudflare.com');
  });

  it('keeps unsafe-eval in development', async () => {
    const directive = await getScriptSrcDirective('development');
    expect(directive).toContain("'unsafe-eval'");
  });

  it('keeps the Turnstile frame-src entry untouched', async () => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    const { default: nextConfig } = await import('../next.config');
    const headerGroups = await nextConfig.headers!();
    const csp = headerGroups[0].headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp?.value).toContain('frame-src https://challenges.cloudflare.com');
  });
});
