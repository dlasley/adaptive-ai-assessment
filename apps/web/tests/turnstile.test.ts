import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTurnstileConfigured, verifyTurnstileToken } from '@/lib/turnstile';
import { TURNSTILE_VERIFY_CODE_ACTION } from '@/lib/turnstile-constants';

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date('2026-09-23T12:00:00.000Z');

const APPROVED_HOSTNAME = 'french-1.vercel.app';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

function siteverifyResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    action: TURNSTILE_VERIFY_CODE_ACTION,
    hostname: APPROVED_HOSTNAME,
    challenge_ts: NOW.toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isTurnstileConfigured', () => {
  it('is false when either env var is missing', () => {
    delete process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(isTurnstileConfigured()).toBe(false);

    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    expect(isTurnstileConfigured()).toBe(false);
  });

  it('is true when both env vars are set', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key';
    expect(isTurnstileConfigured()).toBe(true);
  });
});

describe('verifyTurnstileToken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    process.env.TURNSTILE_SECRET_KEY = 'secret-key';
  });

  it('returns not_configured when not configured, without calling fetch', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyTurnstileToken('some-token');
    expect(result).toEqual({ success: false, reason: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns missing_token when no token is provided', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await verifyTurnstileToken(undefined);
    expect(result).toEqual({ success: false, reason: 'missing_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('succeeds when Cloudflare reports success with a matching action and approved hostname', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse() })
    );

    const result = await verifyTurnstileToken('valid-token', '203.0.113.5');
    expect(result).toEqual({ success: true });
  });

  it('sends remoteip and a fresh idempotency_key on each call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse() });
    vi.stubGlobal('fetch', fetchMock);

    await verifyTurnstileToken('valid-token', '203.0.113.5');
    await verifyTurnstileToken('valid-token', '203.0.113.5');

    const bodyOne = fetchMock.mock.calls[0][1].body as URLSearchParams;
    const bodyTwo = fetchMock.mock.calls[1][1].body as URLSearchParams;

    expect(bodyOne.get('remoteip')).toBe('203.0.113.5');
    expect(bodyOne.get('idempotency_key')).toBeTruthy();
    expect(bodyOne.get('idempotency_key')).not.toBe(bodyTwo.get('idempotency_key'));
  });

  it('returns challenge_failed when Cloudflare reports failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse({ success: false }) })
    );

    const result = await verifyTurnstileToken('invalid-token');
    expect(result).toEqual({ success: false, reason: 'challenge_failed' });
  });

  it('returns action_mismatch when the action does not match the protected surface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => siteverifyResponse({ action: 'some_other_action' }),
      })
    );

    const result = await verifyTurnstileToken('valid-token');
    expect(result).toEqual({ success: false, reason: 'action_mismatch' });
  });

  it('returns hostname_not_allowed when the hostname is not on the approved list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => siteverifyResponse({ hostname: 'evil.example.com' }),
      })
    );

    const result = await verifyTurnstileToken('valid-token');
    expect(result).toEqual({ success: false, reason: 'hostname_not_allowed' });
  });

  it('returns token_expired when the challenge is older than 300 seconds', async () => {
    const staleTs = new Date(NOW.getTime() - 301_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse({ challenge_ts: staleTs }) })
    );

    const result = await verifyTurnstileToken('valid-token');
    expect(result).toEqual({ success: false, reason: 'token_expired' });
  });

  it('accepts a challenge exactly at the 300 second boundary', async () => {
    const boundaryTs = new Date(NOW.getTime() - 300_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse({ challenge_ts: boundaryTs }) })
    );

    const result = await verifyTurnstileToken('valid-token');
    expect(result).toEqual({ success: true });
  });

  it('fails closed with network_error when the siteverify request itself errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    const result = await verifyTurnstileToken('some-token');
    expect(result).toEqual({ success: false, reason: 'network_error' });
  });

  it('fails closed with network_error when siteverify responds non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));

    const result = await verifyTurnstileToken('some-token');
    expect(result).toEqual({ success: false, reason: 'network_error' });
  });

  describe('test-key hostname handling', () => {
    beforeEach(() => {
      process.env.TURNSTILE_SECRET_KEY = TEST_SECRET;
    });

    it('accepts the fixed placeholder hostname Cloudflare returns for the test secret', async () => {
      // Confirmed by calling siteverify directly with the published test
      // secret: it always reports hostname "example.com", never the real
      // request host, so it can never appear on the production allowlist.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => siteverifyResponse({ hostname: 'example.com' }),
        })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
    });

    it("accepts the test secret's response, which carries no action field", async () => {
      // Cloudflare's live siteverify response for the published test secret is
      // { success, challenge_ts, hostname: "example.com", metadata }, with no action.
      const response: Record<string, unknown> = { ...siteverifyResponse({ hostname: 'example.com' }) };
      delete response.action;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => response }));

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
    });

    it('rejects a test secret configured in production before calling siteverify', async () => {
      process.env.VERCEL_ENV = 'production';
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: false, reason: 'test_secret_in_production' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a test secret on a self-hosted production server, where VERCEL_ENV is unset', async () => {
      delete process.env.VERCEL_ENV;
      vi.stubEnv('NODE_ENV', 'production');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: false, reason: 'test_secret_in_production' });
      expect(fetchMock).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
    });

    it('still accepts a test secret on a Vercel preview, whose NODE_ENV is production', async () => {
      process.env.VERCEL_ENV = 'preview';
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => siteverifyResponse({ hostname: 'example.com' }) })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
      vi.unstubAllEnvs();
    });

    it('does not skip the hostname check for the production secret', async () => {
      process.env.TURNSTILE_SECRET_KEY = 'a-real-production-secret';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => siteverifyResponse({ hostname: 'example.com' }),
        })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: false, reason: 'hostname_not_allowed' });
    });
  });

  describe('Vercel-provided hostnames', () => {
    it('accepts VERCEL_PROJECT_PRODUCTION_URL when present', async () => {
      process.env.VERCEL_PROJECT_PRODUCTION_URL = 'my-preview-alias.vercel.app';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => siteverifyResponse({ hostname: 'my-preview-alias.vercel.app' }),
        })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
    });

    it('accepts VERCEL_BRANCH_URL when present', async () => {
      process.env.VERCEL_BRANCH_URL = 'adaptive-ai-assessment-git-feature-x.vercel.app';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => siteverifyResponse({ hostname: 'adaptive-ai-assessment-git-feature-x.vercel.app' }),
        })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
    });

    it('accepts VERCEL_URL, the per-deployment host, when present', async () => {
      process.env.VERCEL_URL = 'adaptive-ai-assessment-abc123-davids-projects.vercel.app';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => siteverifyResponse({ hostname: 'adaptive-ai-assessment-abc123-davids-projects.vercel.app' }),
        })
      );

      const result = await verifyTurnstileToken('valid-token');
      expect(result).toEqual({ success: true });
    });
  });
});
