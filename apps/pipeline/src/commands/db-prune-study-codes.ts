#!/usr/bin/env npx tsx
/**
 * Deletes study codes that have not been active for a number of days. A code's activity is its last
 * quiz submission (or its creation, if it never submitted one). Deleting a code cascades to its quiz
 * history, question results and Leitner state. A dry run unless `--write-db`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createScriptSupabase, fetchAllPages } from '../lib/db-queries';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('db-prune-study-codes');

const DAY_MS = 24 * 60 * 60 * 1000;
const ID_CHUNK_SIZE = 100;

export const cli = defineCli(
  {
    ...dbTargetFlags,
    'inactive-days': {
      type: 'number',
      default: 90,
      min: 1,
      help: 'Prune codes whose last activity is older than this many days',
    },
    'no-quizzes-only': {
      type: 'boolean',
      default: false,
      help: 'Prune only codes that never submitted a quiz (checked against quiz_history)',
    },
    ...loggingFlags,
  },
  {
    name: 'db-prune-study-codes',
    description:
      'Delete study codes with no activity for N days. Cascades to their quiz history. Dry run unless --write-db.',
    examples: [
      'npx tsx apps/pipeline/src/commands/db-prune-study-codes.ts --inactive-days 90 --no-quizzes-only',
      'npx tsx apps/pipeline/src/commands/db-prune-study-codes.ts --inactive-days 90 --no-quizzes-only --write-db',
    ],
  },
);

export interface PruneOptions {
  inactiveDays: number;
  noQuizzesOnly: boolean;
  write: boolean;
  now?: Date;
}

export interface PruneResult {
  /** Codes whose last activity is older than the cutoff. */
  inactive: number;
  /** Of those, how many have at least one quiz_history row. */
  inactiveWithQuizzes: number;
  /** Codes this run selected for deletion. */
  selected: number;
  /** Codes actually deleted (0 on a dry run). */
  deleted: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Ids among `ids` that own at least one quiz_history row. */
async function idsWithQuizzes(supabase: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const group of chunk(ids, ID_CHUNK_SIZE)) {
    const rows = await fetchAllPages<{ study_code_id: string }>(
      supabase,
      'quiz_history',
      (query) => query.in('study_code_id', group),
      'id, study_code_id',
    );
    for (const row of rows) owners.add(row.study_code_id);
  }
  return owners;
}

export async function pruneStudyCodes(supabase: SupabaseClient, options: PruneOptions): Promise<PruneResult> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - options.inactiveDays * DAY_MS).toISOString();

  const inactiveRows = await fetchAllPages<{ id: string }>(
    supabase,
    'study_codes',
    (query) => query.lt('last_active_at', cutoff),
    'id',
  );
  const inactiveIds = inactiveRows.map((row) => row.id);

  // total_quizzes can lag quiz_history when a totals update fails, so the history itself decides.
  const owners = await idsWithQuizzes(supabase, inactiveIds);
  const selectedIds = options.noQuizzesOnly ? inactiveIds.filter((id) => !owners.has(id)) : inactiveIds;

  let deleted = 0;
  if (options.write) {
    for (const group of chunk(selectedIds, ID_CHUNK_SIZE)) {
      const { error } = await supabase.from('study_codes').delete().in('id', group);
      if (error) throw new Error(`Error deleting study codes: ${error.message}`);
      deleted += group.length;
    }
  }

  return {
    inactive: inactiveIds.length,
    inactiveWithQuizzes: owners.size,
    selected: selectedIds.length,
    deleted,
  };
}

async function main() {
  const options = cli.parse();
  setLogLevel(levelFromFlags(options));

  const supabase = createScriptSupabase({ write: options.writeDb, serviceRole: true });
  const result = await pruneStudyCodes(supabase, {
    inactiveDays: options.inactiveDays,
    noQuizzesOnly: options.noQuizzesOnly,
    write: options.writeDb,
  });

  console.log(`Study codes inactive for more than ${options.inactiveDays} days: ${result.inactive}`);
  console.log(`  with quiz history: ${result.inactiveWithQuizzes}`);
  console.log(`  without quiz history: ${result.inactive - result.inactiveWithQuizzes}`);
  console.log(`Selected for deletion${options.noQuizzesOnly ? ' (never took a quiz)' : ''}: ${result.selected}`);

  if (!options.writeDb) {
    console.log('\nDRY RUN: nothing deleted. Pass --write-db to delete the selected codes.');
    return;
  }
  logger.info(`Deleted ${result.deleted} study codes`);
}

runIfMain(import.meta.url, main);
