/**
 * Read-only check that the service key can reach each core table and view. Reports a row count
 * per table and writes nothing.
 *
 * Run with: npx tsx apps/pipeline/src/commands/db-check-connection.ts
 */

import { createServiceReadClient, type ReadOnlySupabaseClient } from '../lib/db-queries';
import { runIfMain } from '../lib/run-if-main';

/** No defineCli(): this script takes no flags beyond --help. `lib/dispatch/discovery.ts` reads
 * this export instead of a `cli` export for a bespoke command with no flag spec. */
export const commandMeta = {
  name: 'db-check-connection',
  description: 'Check that the service key can read each core table and view. Writes nothing.',
};

const CORE_RELATIONS = [
  'study_codes',
  'quiz_history',
  'question_results',
  'leitner_state',
  'questions',
  'batches',
  'units',
  'learning_resources',
  'study_code_source_words',
  'concept_mastery',
  'weak_topics',
  'strong_topics',
] as const;

export interface RelationCheck {
  relation: string;
  count: number | null;
  error: string | null;
}

/** Counts the rows of each relation through a select-only client; a failed read is recorded, not thrown. */
export async function checkRelations(
  client: ReadOnlySupabaseClient,
  relations: readonly string[] = CORE_RELATIONS,
): Promise<RelationCheck[]> {
  const results: RelationCheck[] = [];
  for (const relation of relations) {
    const { count, error } = await client.from(relation).select('*', { count: 'exact', head: true });
    results.push({ relation, count: error ? null : (count ?? 0), error: error ? error.message : null });
  }
  return results;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
Check Database Connection

Usage: npx tsx apps/pipeline/src/commands/db-check-connection.ts

Reads each core table and view with the service key (SUPABASE_SECRET_KEY) and prints
whether it could be read and how many rows it holds. Writes nothing.
No options.
`);
    process.exit(0);
  }

  const results = await checkRelations(createServiceReadClient());

  console.log('');
  for (const { relation, count, error } of results) {
    console.log(error ? `  FAIL  ${relation}: ${error}` : `  ok    ${relation}: ${count} rows`);
  }

  const failed = results.filter((r) => r.error);
  console.log('');
  if (failed.length === 0) {
    console.log('Every core table and view is readable with the service key.');
    return;
  }
  console.log(`${failed.length} of ${results.length} could not be read.`);
  console.log('A missing relation usually means supabase/schema.sql has not been applied to this project.');
  process.exit(1);
}

runIfMain(import.meta.url, main);
