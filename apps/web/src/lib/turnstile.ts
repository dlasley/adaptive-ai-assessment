/**
 * Cloudflare Turnstile server-side verification for verify-code's tightened
 * mode. Active only when both NEXT_PUBLIC_TURNSTILE_SITE_KEY and
 * TURNSTILE_SECRET_KEY are configured. A production-mode server refuses
 * verify-code requests without them; outside production, tightened mode
 * answers 429 until its window ends.
 */

import 'server-only';
import crypto from 'crypto';
import { TURNSTILE_VERIFY_CODE_ACTION } from './turnstile-constants';
import { isLiveProduction } from './environment';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** A token is rejected once its challenge is older than this, per Cloudflare's replay-window guidance. */
const MAX_TOKEN_AGE_MS = 300_000;

/**
 * Hostnames approved on the Cloudflare Turnstile widget's hostname
 * management list. Must match that list exactly — adding a hostname here
 * without also adding it in the Cloudflare dashboard (or vice versa) breaks
 * verification for that host.
 */
const APPROVED_HOSTNAMES = [
  'french-2.amazingzebra.com',
  'french-1.vercel.app',
  'adaptive-ai-assessment-davids-projects-518494f9.vercel.app',
  'adaptive-ai-assessment-git-main-davids-projects-518494f9.vercel.app',
  'localhost',
  '127.0.0.1',
];

/**
 * Cloudflare's published dummy secret keys (see
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 * Their siteverify responses report a fixed placeholder hostname
 * ("example.com") rather than the
 * real request host, since the widget never runs a real challenge for them.
 * Local development and forks use one of these, so hostname validation is
 * skipped in that branch only. A live production secret is never a member of
 * this set, so its hostname check is never weakened.
 */
const TEST_SECRET_KEYS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

function allowedHostnames(): Set<string> {
  const hostnames = new Set(APPROVED_HOSTNAMES);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    hostnames.add(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  }
  if (process.env.VERCEL_BRANCH_URL) {
    hostnames.add(process.env.VERCEL_BRANCH_URL);
  }
  if (process.env.VERCEL_URL) {
    hostnames.add(process.env.VERCEL_URL);
  }
  return hostnames;
}

interface TurnstileSiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  'error-codes'?: string[];
}

type TurnstileFailureReason =
  | 'test_secret_in_production'
  | 'not_configured'
  | 'missing_token'
  | 'network_error'
  | 'invalid_response'
  | 'challenge_failed'
  | 'action_mismatch'
  | 'hostname_not_allowed'
  | 'token_expired';

export type TurnstileVerificationResult =
  | { success: true }
  | { success: false; reason: TurnstileFailureReason };

export function isTurnstileConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);
}

/**
 * Verifies a Turnstile token against Cloudflare's siteverify endpoint.
 * Checks success, that the action matches the protected surface, that the
 * hostname is on the approved list, and that the challenge is no older than
 * MAX_TOKEN_AGE_MS. Fails closed on any network or shape error.
 *
 * Cloudflare's published test secrets return neither the widget's action nor a
 * real hostname, so both checks are skipped when the configured secret is one of
 * them. A test secret configured in production is rejected outright.
 */
export async function verifyTurnstileToken(
  token: string | undefined,
  remoteIp?: string
): Promise<TurnstileVerificationResult> {
  if (!isTurnstileConfigured()) return { success: false, reason: 'not_configured' };
  if (!token) return { success: false, reason: 'missing_token' };

  const secret = process.env.TURNSTILE_SECRET_KEY!;
  const usingTestSecret = TEST_SECRET_KEYS.has(secret);
  if (usingTestSecret && isLiveProduction()) {
    return { success: false, reason: 'test_secret_in_production' };
  }

  let data: TurnstileSiteverifyResponse;
  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      idempotency_key: crypto.randomUUID(),
    });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body });
    if (!res.ok) return { success: false, reason: 'network_error' };

    data = (await res.json()) as TurnstileSiteverifyResponse;
  } catch {
    return { success: false, reason: 'network_error' };
  }

  if (!data.success) return { success: false, reason: 'challenge_failed' };
  if (!usingTestSecret) {
    if (data.action !== TURNSTILE_VERIFY_CODE_ACTION) return { success: false, reason: 'action_mismatch' };
    if (!data.hostname || !allowedHostnames().has(data.hostname)) {
      return { success: false, reason: 'hostname_not_allowed' };
    }
  }

  if (!data.challenge_ts) return { success: false, reason: 'invalid_response' };
  const ageMs = Date.now() - Date.parse(data.challenge_ts);
  if (!Number.isFinite(ageMs) || ageMs > MAX_TOKEN_AGE_MS) {
    return { success: false, reason: 'token_expired' };
  }

  return { success: true };
}
