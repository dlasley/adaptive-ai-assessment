/**
 * Loads the repo-root `.env.local` into `process.env`. Called from inside `main()` (never at
 * module scope) by every command that needs it directly, and by `db-queries.ts`'s
 * `createScriptSupabase()`/`createServiceReadClient()` for the rest — so importing a command
 * module (to read its spec, e.g. from `lib/dispatch/discovery.ts`) never reads an env file as a
 * side effect.
 */

import { config } from 'dotenv';
import path from 'path';
import { REPO_ROOT } from './paths';

export function loadEnv(): void {
  // dotenv >=17 prints a random promotional "tip" line on every config() call unless quieted.
  config({ path: path.join(REPO_ROOT, '.env.local'), quiet: true });
}
