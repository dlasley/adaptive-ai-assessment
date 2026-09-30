/**
 * Prints what `assertSupabaseTarget()` (`../supabase-target.ts`) will actually decide when the
 * spawned command runs, without exiting — guided mode and guided workflows preview this before
 * asking the user to confirm a write-capable step, rather than finding out only after the spawned
 * child's own guard refuses the write. `confirmed: false` matches guided mode's real behavior: it
 * never passes `--yes-production` to a spawned command (see `guided.ts`'s `walkSpecs()`, which
 * skips that flag entirely), so the only way a write is confirmed is `EXPECTED_SUPABASE_REF`
 * matching — exactly what the same `decideSupabaseTarget()` call the real guard uses would decide.
 */

import { loadEnv } from '../env';
import { decideSupabaseTarget } from '../supabase-target';

/** Returns true when a write would be allowed, false when the guard would refuse it. */
export function previewSupabaseTarget(): boolean {
  loadEnv();
  const decision = decideSupabaseTarget({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    write: true,
    expectedRef: process.env.EXPECTED_SUPABASE_REF,
    confirmed: false,
  });

  if (decision.outcome === 'refused') {
    console.log(`Supabase target: ${decision.ref ?? '(unresolved)'} — will be REFUSED: ${decision.reason}`);
    return false;
  }

  if (decision.outcome === 'confirmed') {
    const via = decision.via === 'expected-ref-match' ? 'EXPECTED_SUPABASE_REF' : '--yes-production';
    console.log(`Supabase target: ${decision.ref} (confirmed via ${via})`);
    return true;
  }

  console.log(`Supabase target: ${decision.ref ?? '(unresolved)'}`);
  return true;
}

/** Printed when a guided write step stops because its target is not confirmed. */
export function printUnconfirmedTargetHelp(): void {
  console.log('');
  console.log('Stopped: nothing was run. To target the test database, load its settings in this terminal and start again:');
  console.log('  set -a; source .env.test.local; set +a');
  console.log('To write to production, run the steps as direct commands with --yes-production');
  console.log('(see docs/cli-guide-content-ingestion-and-question-pipeline.md).');
}
