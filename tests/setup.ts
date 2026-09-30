/**
 * Vitest global setup, registered via `test.setupFiles` in each workspace's `vitest.config.mts`.
 * Runs once per test file, before that file's own imports are evaluated, so a module that reads a
 * credential env var at import time (e.g. `apps/web/src/lib/supabase.ts`) never sees a real value.
 * See `credential-guard.ts` for what's stripped and the `RUN_DB_TESTS=1` exception.
 *
 * The guard also reruns in a global `beforeEach`. Several pipeline modules (`apps/pipeline/lib/db-queries.ts`
 * and others) call `loadEnv()` (`apps/pipeline/lib/env.ts`) at import time, which loads the
 * repo-root `.env.local` via dotenv; dotenv fills in only the keys that are currently unset, so once
 * this file's initial strip clears a var, a transitively imported pipeline module reading a real
 * `.env.local` from disk repopulates it before any test body runs. The `beforeEach` strip closes
 * that reopened window.
 */

import { beforeEach } from 'vitest';
import { applyCredentialGuard } from './credential-guard';

applyCredentialGuard();

beforeEach(() => {
  applyCredentialGuard();
});
