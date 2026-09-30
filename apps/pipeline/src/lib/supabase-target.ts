/**
 * Guards write-capable pipeline scripts against silently targeting the
 * wrong Supabase project. dotenv doesn't override already-exported shell
 * vars, so `export`ing `.env.test.local` before running a script is a
 * manual step with nothing enforcing it — this makes a wrong target fail
 * loudly instead of writing to production by accident.
 *
 * `resolveSupabaseRef` and `decideSupabaseTarget` are pure so the decision
 * logic is testable without mocking `process.env`/`process.argv`;
 * `assertSupabaseTarget` is the thin side-effecting wrapper scripts call.
 */

import { createLogger } from './logger';

const logger = createLogger('supabase-target');

/**
 * Extracts the project ref (e.g. "abcdefghijklmnopqrst") from a Supabase
 * project URL. Returns null if the URL is missing, malformed, or its
 * hostname isn't the standard `<ref>.supabase.co` shape.
 */
export function resolveSupabaseRef(url: string | undefined | null): string | null {
  if (!url) return null;

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  const [ref, ...rest] = hostname.split('.');
  if (!ref || rest.join('.') !== 'supabase.co') return null;

  return ref.toLowerCase();
}

export type SupabaseTargetDecision =
  | { outcome: 'print-only'; ref: string | null }
  | { outcome: 'confirmed'; ref: string; via: 'expected-ref-match' | 'yes-production-flag' }
  | { outcome: 'refused'; ref: string | null; reason: string };

export interface SupabaseTargetInput {
  /** Raw `NEXT_PUBLIC_SUPABASE_URL` value. */
  url: string | undefined;
  /** Whether the caller is about to write to the DB. */
  write: boolean;
  /** Raw `EXPECTED_SUPABASE_REF` value. */
  expectedRef: string | undefined;
  /** Whether `--yes-production` (or equivalent) was passed. */
  confirmed: boolean;
}

/**
 * Decides whether a resolved Supabase target may be written to. Read-only
 * calls (`write: false`) always print-only — the target is confirmed only
 * when it's actually about to be mutated.
 */
export function decideSupabaseTarget(input: SupabaseTargetInput): SupabaseTargetDecision {
  const ref = resolveSupabaseRef(input.url);

  if (!input.write) {
    return { outcome: 'print-only', ref };
  }

  if (!ref) {
    return {
      outcome: 'refused',
      ref,
      reason: 'Could not resolve a Supabase project ref from NEXT_PUBLIC_SUPABASE_URL.',
    };
  }

  const expectedRef = input.expectedRef?.trim().toLowerCase() || undefined;

  if (expectedRef && expectedRef === ref) {
    return { outcome: 'confirmed', ref, via: 'expected-ref-match' };
  }

  if (input.confirmed) {
    return { outcome: 'confirmed', ref, via: 'yes-production-flag' };
  }

  const reason = expectedRef
    ? `EXPECTED_SUPABASE_REF (${expectedRef}) does not match the resolved target (${ref}), and --yes-production was not passed.`
    : `Target (${ref}) is not confirmed. If this is the database you mean to write to, pass --yes-production. For routine runs against the test database, set EXPECTED_SUPABASE_REF in .env.test.local; never set it to the production ref.`;

  return { outcome: 'refused', ref, reason };
}

/**
 * Prints the resolved Supabase target and, for write-capable calls,
 * enforces that it's confirmed before letting the caller proceed. Exits
 * the process on refusal.
 */
export function assertSupabaseTarget(opts: { write: boolean }): void {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const decision = decideSupabaseTarget({
    url,
    write: opts.write,
    expectedRef: process.env.EXPECTED_SUPABASE_REF,
    confirmed: process.argv.includes('--yes-production'),
  });

  logger.info(`Supabase target: ${decision.ref ?? '(unresolved)'} (${url ?? 'NEXT_PUBLIC_SUPABASE_URL not set'})`);

  if (decision.outcome === 'refused') {
    logger.error(`Refusing to write: ${decision.reason}`);
    process.exit(1);
  }

  if (decision.outcome === 'confirmed') {
    const expectedRef = process.env.EXPECTED_SUPABASE_REF?.trim().toLowerCase();
    if (decision.via === 'yes-production-flag' && expectedRef && expectedRef !== decision.ref) {
      logger.warn(
        `Writing to ${decision.ref} on --yes-production, overriding EXPECTED_SUPABASE_REF=${expectedRef}.`,
      );
    } else {
      const source = decision.via === 'expected-ref-match' ? 'EXPECTED_SUPABASE_REF' : '--yes-production';
      logger.info(`Write target confirmed via ${source}.`);
    }
  }
}
