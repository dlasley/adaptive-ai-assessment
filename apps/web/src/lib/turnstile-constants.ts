/**
 * The Cloudflare Turnstile `action` identifier for the verify-code circuit
 * breaker challenge. Shared between the server-side siteverify check
 * (src/lib/turnstile.ts) and the client widget so the two always agree —
 * siteverify rejects a token whose action doesn't match what's expected.
 */
export const TURNSTILE_VERIFY_CODE_ACTION = 'verify_code';
