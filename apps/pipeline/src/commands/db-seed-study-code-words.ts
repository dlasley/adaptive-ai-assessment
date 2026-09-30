#!/usr/bin/env npx tsx
/**
 * Seed study_code_source_words table with adjective/animal word pools.
 *
 * Randomly samples from friendly-words predicates + animals npm package
 * and inserts into the database. The sampled subset is unknown from source,
 * preventing brute-force enumeration of study codes.
 */

import { createScriptSupabase } from '../lib/db-queries';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { runIfMain } from '../lib/run-if-main';

const logger = createLogger('db-seed-study-code-words');

// ─── Random sampling ─────────────────────────────────────────────────────────

/** Fisher-Yates shuffle (in-place) and take the first N elements */
function sampleRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export const cli = defineCli(
  {
    ...dbTargetFlags,
    count: {
      type: 'number',
      default: 200,
      min: 1,
      help: 'How many of each category to sample',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      help: 'Show what would be inserted (default unless --write-db)',
    },
    ...loggingFlags,
  },
  {
    name: 'db-seed-study-code-words',
    description: 'Seed study_code_source_words with adjective/animal word pools.',
    examples: [
      'npx tsx apps/pipeline/src/commands/db-seed-study-code-words.ts --dry-run',
      'npx tsx apps/pipeline/src/commands/db-seed-study-code-words.ts --count 300 --write-db',
    ],
  },
);

async function main() {
  const options = cli.parse();
  setLogLevel(levelFromFlags(options));
  // Dry-run unless --write-db, matching every other write-capable script in this repo.
  const dryRun = options.writeDb ? options.dryRun : true;

  const friendlyWords = require('friendly-words');
  const animalsPackage = require('animals');

  const allPredicates: string[] = friendlyWords.predicates;
  const allAnimals: string[] = animalsPackage.words;

  const adjCount = Math.min(options.count, allPredicates.length);
  const aniCount = Math.min(options.count, allAnimals.length);

  const adjectives = sampleRandom(allPredicates, adjCount);
  const animals = sampleRandom(allAnimals, aniCount);

  console.log(`Source: friendly-words (${allPredicates.length} predicates) + animals (${allAnimals.length} animals)`);
  console.log(`Sampled: ${adjectives.length} adjectives, ${animals.length} animals`);
  console.log(`Combination space: ${adjectives.length * animals.length} possible codes`);

  // Build rows
  const rows = [
    ...adjectives.map(word => ({ category: 'adjective' as const, word })),
    ...animals.map(word => ({ category: 'animal' as const, word })),
  ];

  // Letter coverage analysis
  const adjLetters = new Set(adjectives.map(w => w[0]));
  const aniLetters = new Set(animals.map(w => w[0]));
  const overlap = [...adjLetters].filter(l => aniLetters.has(l));
  console.log(`\nAlliteration coverage: ${overlap.length} letters have both adjectives and animals`);
  console.log(`  Adjective letters: ${[...adjLetters].sort().join(', ')}`);
  console.log(`  Animal letters: ${[...aniLetters].sort().join(', ')}`);
  console.log(`  Overlapping: ${overlap.sort().join(', ')}`);

  if (dryRun) {
    console.log(`\nDRY RUN — ${rows.length} rows would be inserted`);
    console.log('\nSample adjectives:', adjectives.slice(0, 10).join(', '), '...');
    console.log('Sample animals:', animals.slice(0, 10).join(', '), '...');
    return;
  }

  // Write to DB
  console.log(`\nWriting ${rows.length} rows to study_code_source_words...`);
  const supabase = createScriptSupabase({ write: true });

  // Insert in chunks of 200 with ON CONFLICT DO NOTHING via upsert
  const CHUNK_SIZE = 200;
  let insertedTotal = 0;
  let skippedTotal = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const { data, error } = await supabase
      .from('study_code_source_words')
      .upsert(chunk, { onConflict: 'category,word', ignoreDuplicates: true })
      .select('id');

    if (error) {
      logger.error(`Chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed`, { message: error.message });
    } else {
      const inserted = data?.length ?? 0;
      insertedTotal += inserted;
      skippedTotal += chunk.length - inserted;
    }
  }

  console.log(`\nDone: ${insertedTotal} inserted, ${skippedTotal} duplicates skipped`);
}

runIfMain(import.meta.url, main);
