/**
 * Export questions table to JSON for inspection, archival, or cross-model audit.
 */

import { writeFileSync } from 'fs';
import { fetchAllPages } from '../lib/db-queries';
import { defineCli } from '../lib/options/define-cli';
import { questionFilterFlags, loggingFlags } from '../lib/options/groups';
import { createLogger } from '../lib/logger';
import { bootstrapCommand } from '../lib/command-bootstrap';
import { ensureDirFor } from '../lib/fs-utils';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('db-export-questions');

export const cli = defineCli(
  {
    ...questionFilterFlags,
    output: {
      type: 'string',
      default: 'content/exports/corpus-export.json',
      help: 'Output file',
    },
    columns: {
      type: 'string',
      choices: ['minimal', 'full'],
      default: 'minimal',
      help: 'Column set',
    },
    ...loggingFlags,
  },
  {
    name: 'db-export-questions',
    description: 'Export the questions table to JSON for inspection, archival, or cross-model audit.',
    examples: [
      'npx tsx apps/pipeline/src/commands/db-export-questions.ts --output content/exports/corpus-export.json',
      'npx tsx apps/pipeline/src/commands/db-export-questions.ts --output content/exports/corpus-export.json --columns full',
      'npx tsx apps/pipeline/src/commands/db-export-questions.ts --output content/exports/corpus-export.json --unit unit-2',
      'npx tsx apps/pipeline/src/commands/db-export-questions.ts --output content/exports/corpus-export.json --type fill-in-blank',
    ],
  },
);

const MINIMAL_COLUMNS = 'id,question,correct_answer,type,difficulty,topic,unit_id,writing_type,options,acceptable_variations';
const FULL_COLUMNS = 'id,question,correct_answer,explanation,type,difficulty,topic,unit_id,writing_type,options,acceptable_variations,hints,content_hash,batch_id,generated_by,quality_status,source_file,created_at';

async function main() {
  const { options, supabase } = await bootstrapCommand(cli);
  const columns = options.columns === 'full' ? FULL_COLUMNS : MINIMAL_COLUMNS;

  console.log(`Exporting questions (${options.columns} columns)...`);

  const filters = [
    options.unit && `unit=${options.unit}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
  ].filter(Boolean);
  if (filters.length) console.log(`  Filters: ${filters.join(', ')}`);

  const all = await fetchAllPages<Record<string, unknown>>(
    supabase,
    'questions',
    (query) => {
      if (options.unit) query = query.eq('unit_id', options.unit);
      if (options.difficulty) query = query.eq('difficulty', options.difficulty);
      if (options.type) query = query.eq('type', options.type);
      return query;
    },
    columns,
  );

  console.log(`  Found ${all.length} questions.`);

  ensureDirFor(options.output);
  writeFileSync(options.output, JSON.stringify(all, null, 2));
  console.log(`  Written to ${options.output}`);

  // Summary stats
  const types = [...new Set(all.map(q => q.type as string))];
  for (const t of types) {
    const count = all.filter(q => q.type === t).length;
    console.log(`    ${t}: ${count}`);
  }

  const diffs = [...new Set(all.map(q => q.difficulty as string))];
  for (const d of diffs) {
    const count = all.filter(q => q.difficulty === d).length;
    console.log(`    ${d}: ${count}`);
  }
}

runIfMain(import.meta.url, main);
