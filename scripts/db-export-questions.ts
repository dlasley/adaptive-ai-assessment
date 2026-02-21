/**
 * Export questions table to JSON for inspection, archival, or cross-model audit.
 *
 * Usage:
 *   npx tsx scripts/export-questions.ts --output data/corpus-export.json
 *   npx tsx scripts/export-questions.ts --output data/corpus-export.json --columns minimal
 *   npx tsx scripts/export-questions.ts --output data/corpus-export.json --unit unit-2
 *   npx tsx scripts/export-questions.ts --output data/corpus-export.json --type fill-in-blank
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface CLIOptions {
  output: string;
  columns: 'minimal' | 'full';
  unitId?: string;
  difficulty?: string;
  type?: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    output: 'data/corpus-export.json',
    columns: 'minimal',
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output': options.output = args[++i]; break;
      case '--columns': options.columns = args[++i] as 'minimal' | 'full'; break;
      case '--unit': options.unitId = args[++i]; break;
      case '--difficulty': options.difficulty = args[++i]; break;
      case '--type': options.type = args[++i]; break;
    }
  }
  return options;
}

const MINIMAL_COLUMNS = 'id,question,correct_answer,type,difficulty,topic,unit_id,writing_type,options,acceptable_variations';
const FULL_COLUMNS = 'id,question,correct_answer,explanation,type,difficulty,topic,unit_id,writing_type,options,acceptable_variations,hints,content_hash,batch_id,generated_by,quality_status,source_file,created_at';

const PAGE_SIZE = 1000;

async function main() {
  const options = parseArgs();
  const columns = options.columns === 'full' ? FULL_COLUMNS : MINIMAL_COLUMNS;

  console.log(`Exporting questions (${options.columns} columns)...`);

  const filters = [
    options.unitId && `unit=${options.unitId}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
  ].filter(Boolean);
  if (filters.length) console.log(`  Filters: ${filters.join(', ')}`);

  // Paginated fetch
  let all: Record<string, unknown>[] = [];
  let page = 0;
  while (true) {
    let query = supabase
      .from('questions')
      .select(columns);
    if (options.unitId) query = query.eq('unit_id', options.unitId);
    if (options.difficulty) query = query.eq('difficulty', options.difficulty);
    if (options.type) query = query.eq('type', options.type);
    query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data as unknown as Record<string, unknown>[]);
    page++;
  }

  console.log(`  Found ${all.length} questions.`);

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

main().catch(console.error);
