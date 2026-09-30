/**
 * Option groups shared across pipeline scripts. A script spreads the whole group into its
 * `defineCli()` spec object (`{ ...dbTargetFlags, ...questionFilterFlags, ...ownFlags }`) rather
 * than redeclaring these fields per file.
 */

import { DIFFICULTIES, QUESTION_TYPES, WRITING_TYPES } from '@adaptive/shared/enums';
import type { OptionSpecs } from './types';

/**
 * `write-db` gates whether a script mutates the database; `yes-production` is read directly by
 * `assertSupabaseTarget()` (`apps/pipeline/src/lib/supabase-target.ts`) via `process.argv`, not through the
 * parsed CLI result — declaring it here only keeps it from tripping the unknown-flag check.
 */
export const dbTargetFlags = {
  'write-db': {
    type: 'boolean',
    default: false,
    deprecatedAliases: ['sync-db', 'mark-db'],
    help: 'Write results to the database (uses the secret key, bypasses RLS)',
    group: 'Database target',
  },
  'yes-production': {
    type: 'boolean',
    default: false,
    help: 'Confirm a write-capable run against an unexpected Supabase target',
    group: 'Database target',
  },
} satisfies OptionSpecs;

/**
 * `verbose`/`quiet` resolve to a `apps/pipeline/src/lib/logger.ts` level via `levelFromFlags()`. Declaring
 * them here means every script that spreads this group gets consistent flag names and help text,
 * without each one hand-rolling its own verbosity flags.
 */
export const loggingFlags = {
  verbose: {
    type: 'boolean',
    default: false,
    help: 'Show debug-level tracing',
    group: 'Logging',
  },
  quiet: {
    type: 'boolean',
    default: false,
    help: 'Only show warnings and errors',
    group: 'Logging',
  },
} satisfies OptionSpecs;

export const questionFilterFlags = {
  unit: { type: 'string', help: 'Filter by unit id', group: 'Filters' },
  difficulty: {
    type: 'string',
    choices: DIFFICULTIES,
    help: 'Filter by difficulty',
    group: 'Filters',
  },
  type: { type: 'string', choices: QUESTION_TYPES, help: 'Filter by question type', group: 'Filters' },
  'writing-type': {
    type: 'string',
    choices: WRITING_TYPES,
    help: 'Writing subtype (requires --type writing)',
    group: 'Filters',
  },
  'batch-id': { type: 'string', help: 'Filter by batch_id', group: 'Filters' },
} satisfies OptionSpecs;
