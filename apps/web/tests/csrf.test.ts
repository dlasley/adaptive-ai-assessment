import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyCsrfProtection } from '@/lib/csrf';

const PROD_URL = 'french-1.vercel.app';

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://french-1.vercel.app/api/verify-code', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
});

describe('verifyCsrfProtection', () => {
  it('rejects a mismatched Origin', () => {
    const result = verifyCsrfProtection(
      makeRequest({ origin: 'https://evil.com', 'content-type': 'application/json' })
    );
    expect(result?.status).toBe(403);
  });

  it('rejects when neither Origin nor Referer is present', () => {
    const result = verifyCsrfProtection(makeRequest({ 'content-type': 'application/json' }));
    expect(result?.status).toBe(403);
  });

  it('rejects a non-JSON Content-Type before any origin check matters', () => {
    const result = verifyCsrfProtection(
      makeRequest({
        origin: `https://${PROD_URL}`,
        'content-type': 'text/plain',
      })
    );
    expect(result?.status).toBe(415);
  });

  it('passes a matching Origin with the correct Content-Type', () => {
    const result = verifyCsrfProtection(
      makeRequest({ origin: `https://${PROD_URL}`, 'content-type': 'application/json' })
    );
    expect(result).toBeNull();
  });

  describe('Referer fallback', () => {
    it('rejects a legitimate origin embedded as a query-string value (defeats naive .includes())', () => {
      const result = verifyCsrfProtection(
        makeRequest({
          referer: `https://evil.com/?x=https://${PROD_URL}`,
          'content-type': 'application/json',
        })
      );
      expect(result?.status).toBe(403);
    });

    it('rejects a legitimate origin as a subdomain prefix (defeats naive .startsWith())', () => {
      const result = verifyCsrfProtection(
        makeRequest({
          referer: `https://${PROD_URL}.evil.com`,
          'content-type': 'application/json',
        })
      );
      expect(result?.status).toBe(403);
    });

    it('rejects a malformed Referer (fails closed, not silently skipped)', () => {
      const result = verifyCsrfProtection(
        makeRequest({ referer: 'not a url', 'content-type': 'application/json' })
      );
      expect(result?.status).toBe(403);
    });

    it('accepts a genuinely matching Referer origin', () => {
      const result = verifyCsrfProtection(
        makeRequest({
          referer: `https://${PROD_URL}/some/page`,
          'content-type': 'application/json',
        })
      );
      expect(result).toBeNull();
    });
  });
});

describe('verifyCsrfProtection branch alias', () => {
  const BRANCH_URL = 'adaptive-ai-assessment-git-openrouter-davids-projects-518494f9.vercel.app';

  it('accepts the branch alias origin when VERCEL_BRANCH_URL is set', () => {
    process.env.VERCEL_BRANCH_URL = BRANCH_URL;
    const result = verifyCsrfProtection(
      makeRequest({ origin: `https://${BRANCH_URL}`, 'content-type': 'application/json' })
    );
    expect(result).toBeNull();
  });

  it('rejects the branch alias origin when VERCEL_BRANCH_URL is unset', () => {
    const result = verifyCsrfProtection(
      makeRequest({ origin: `https://${BRANCH_URL}`, 'content-type': 'application/json' })
    );
    expect(result?.status).toBe(403);
  });

  it('rejects a lookalike that only prefixes the branch alias', () => {
    process.env.VERCEL_BRANCH_URL = BRANCH_URL;
    const result = verifyCsrfProtection(
      makeRequest({ origin: `https://${BRANCH_URL}.evil.com`, 'content-type': 'application/json' })
    );
    expect(result?.status).toBe(403);
  });
});
