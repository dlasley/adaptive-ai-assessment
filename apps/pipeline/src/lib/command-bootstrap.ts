/**
 * Shared startup sequence for pipeline commands built on `defineCli()`: parse `process.argv`,
 * set the process-wide log level from the parsed `--verbose`/`--quiet` flags, and create a
 * read-only Supabase client. Pass `{ units: true }` to also fetch every unit via
 * `fetchUnitsFromDb()` once the client exists.
 *
 * Write-capable clients (`createScriptSupabase({ write: true })`) are a separate concern with
 * their own timing per command and are created at their existing call sites, not here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Unit } from '@adaptive/shared/types';
import type { Cli, OptionSpecs, ParsedOptions } from './options/types';
import { createScriptSupabase } from './db-queries';
import { fetchUnitsFromDb } from './units-db';
import { levelFromFlags, setLogLevel } from './logger';

export interface BootstrapCommandOptions {
  /** Also fetch every unit via `fetchUnitsFromDb()` after the client is created. */
  units?: boolean;
}

export function bootstrapCommand<S extends OptionSpecs>(
  cli: Cli<S>,
): Promise<{ options: ParsedOptions<S>; supabase: SupabaseClient; units: undefined }>;
export function bootstrapCommand<S extends OptionSpecs>(
  cli: Cli<S>,
  opts: { units: true },
): Promise<{ options: ParsedOptions<S>; supabase: SupabaseClient; units: Unit[] }>;
export async function bootstrapCommand<S extends OptionSpecs>(
  cli: Cli<S>,
  opts?: BootstrapCommandOptions,
): Promise<{ options: ParsedOptions<S>; supabase: SupabaseClient; units?: Unit[] }> {
  const options = cli.parse();
  setLogLevel(levelFromFlags(options));
  const supabase = createScriptSupabase();
  const units = opts?.units ? await fetchUnitsFromDb(supabase) : undefined;
  return { options, supabase, units };
}
