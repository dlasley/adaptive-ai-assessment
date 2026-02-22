#!/usr/bin/env npx tsx
/**
 * Seed study_code_source_words table with adjective/animal word pools.
 *
 * Two modes:
 *   --from-source   Use the original 120+120 hardcoded arrays (one-time migration)
 *   (default)       Sample randomly from friendly-words predicates + animals package
 *
 * Usage:
 *   npx tsx scripts/db-seed-study-code-source-words.ts [options]
 *
 * Options:
 *   --from-source       Seed from the original hardcoded word lists
 *   --count <N>         How many of each category to sample (default: 200)
 *   --write-db          Actually insert to database
 *   --dry-run           Show what would be inserted (default if no --write-db)
 *   --help, -h          Show this help
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env.local') });

import { createScriptSupabase } from './lib/db-queries';

// ─── Original hardcoded arrays (inline copy for --from-source migration) ─────

const SOURCE_ADJECTIVES = [
  'happy', 'brave', 'clever', 'swift', 'gentle', 'bright', 'calm', 'kind',
  'wise', 'bold', 'cool', 'warm', 'quick', 'strong', 'smart', 'proud',
  'loyal', 'noble', 'wild', 'free', 'sweet', 'pure', 'true', 'fair',
  'grand', 'great', 'fine', 'nice', 'good', 'dear', 'royal', 'magic',
  'lucky', 'jolly', 'merry', 'sunny', 'starry', 'golden', 'silver', 'peaceful',
  'playful', 'cheerful', 'hopeful', 'fearless', 'graceful', 'powerful', 'mighty', 'tiny',
  'giant', 'cosmic', 'arctic', 'tropical', 'mystic', 'epic', 'super', 'ultra',
  'mega', 'hyper', 'neo', 'retro', 'vintage', 'modern', 'ancient', 'future',
  'speedy', 'zippy', 'bouncy', 'fluffy', 'fuzzy', 'shiny', 'sparkly', 'glowing',
  'radiant', 'vibrant', 'vivid', 'dazzling', 'blazing', 'soaring', 'flying', 'sailing',
  'dancing', 'singing', 'smiling', 'laughing', 'dreaming', 'wondering', 'exploring', 'seeking',
  'daring', 'caring', 'sharing', 'loving', 'healing', 'helping', 'guiding', 'leading',
  'rising', 'shining', 'winning', 'roaring', 'howling', 'charging', 'racing', 'rushing',
  'stellar', 'lunar', 'solar', 'astral', 'crystal', 'diamond', 'emerald', 'sapphire',
  'ruby', 'amber', 'jade', 'pearl', 'coral', 'ocean', 'forest', 'mountain',
  'river', 'thunder', 'lightning', 'storm', 'cloud', 'rainbow', 'aurora', 'crimson',
  'azure', 'violet', 'scarlet', 'indigo', 'copper', 'bronze', 'keen', 'eager',
  'active', 'lively', 'peppy', 'perky', 'snappy', 'spunky', 'zippy', 'frisky',
];

const SOURCE_ANIMALS = [
  'elephant', 'panda', 'dolphin', 'tiger', 'eagle', 'lion', 'bear', 'wolf',
  'fox', 'hawk', 'owl', 'deer', 'rabbit', 'otter', 'seal', 'whale',
  'shark', 'dragon', 'phoenix', 'griffin', 'unicorn', 'pegasus', 'sphinx', 'kraken',
  'leopard', 'jaguar', 'cheetah', 'panther', 'cougar', 'lynx', 'bobcat', 'ocelot',
  'monkey', 'gorilla', 'chimp', 'lemur', 'koala', 'kangaroo', 'wombat', 'platypus',
  'wallaby', 'badger', 'ferret', 'meerkat', 'raccoon', 'skunk', 'porcupine', 'hedgehog',
  'beaver', 'squirrel', 'chipmunk', 'hamster', 'gerbil', 'mouse', 'bat', 'raven',
  'crow', 'robin', 'sparrow', 'finch', 'cardinal', 'bluejay', 'hummingbird', 'pelican',
  'flamingo', 'stork', 'heron', 'crane', 'swan', 'goose', 'duck', 'penguin',
  'puffin', 'albatross', 'seagull', 'falcon', 'osprey', 'vulture', 'condor', 'parrot',
  'macaw', 'cockatoo', 'parakeet', 'canary', 'python', 'cobra', 'gecko', 'iguana',
  'turtle', 'tortoise', 'frog', 'toad', 'salamander', 'crab', 'lobster', 'shrimp',
  'octopus', 'squid', 'jellyfish', 'starfish', 'seahorse', 'clownfish', 'salmon', 'trout',
  'bass', 'catfish', 'goldfish', 'butterfly', 'dragonfly', 'firefly', 'ladybug', 'beetle',
  'cricket', 'mantis', 'moth', 'spider', 'scorpion', 'centipede', 'snail', 'slug',
  'worm', 'ant', 'bee', 'wasp', 'hornet', 'termite', 'mosquito', 'fly',
];

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

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    fromSource: false,
    count: 200,
    writeDb: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--from-source':
        options.fromSource = true;
        break;
      case '--count':
        options.count = parseInt(args[++i], 10);
        if (isNaN(options.count) || options.count < 1) {
          console.error('--count must be a positive integer');
          process.exit(1);
        }
        break;
      case '--write-db':
        options.writeDb = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Seed study_code_source_words Table

Usage: npx tsx scripts/db-seed-study-code-source-words.ts [options]

Options:
  --from-source       Seed from the original hardcoded word lists (120+120)
  --count <N>         How many of each category to sample (default: 200)
  --write-db          Actually insert to database
  --dry-run           Show what would be inserted (default)
  --help, -h          Show this help
`);
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!options.writeDb) {
    options.dryRun = true;
  }

  return options;
}

async function main() {
  const options = parseArgs();

  let adjectives: string[];
  let animals: string[];

  if (options.fromSource) {
    // Deduplicate the source arrays (the original had duplicate 'zippy')
    adjectives = [...new Set(SOURCE_ADJECTIVES)];
    animals = [...new Set(SOURCE_ANIMALS)];
    console.log(`Source: hardcoded arrays (${adjectives.length} adjectives, ${animals.length} animals)`);
  } else {
    // Import from npm packages
    const friendlyWords = require('friendly-words');
    const animalsPackage = require('animals');

    const allPredicates: string[] = friendlyWords.predicates;
    const allAnimals: string[] = animalsPackage.words;

    const adjCount = Math.min(options.count, allPredicates.length);
    const aniCount = Math.min(options.count, allAnimals.length);

    adjectives = sampleRandom(allPredicates, adjCount);
    animals = sampleRandom(allAnimals, aniCount);

    console.log(`Source: friendly-words (${allPredicates.length} predicates) + animals (${allAnimals.length} animals)`);
    console.log(`Sampled: ${adjectives.length} adjectives, ${animals.length} animals`);
    console.log(`Combination space: ${adjectives.length * animals.length} possible codes`);
  }

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

  if (options.dryRun && !options.writeDb) {
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
      console.error(`  Chunk ${Math.floor(i / CHUNK_SIZE) + 1} failed: ${error.message}`);
    } else {
      const inserted = data?.length ?? 0;
      insertedTotal += inserted;
      skippedTotal += chunk.length - inserted;
    }
  }

  console.log(`\nDone: ${insertedTotal} inserted, ${skippedTotal} duplicates skipped`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
