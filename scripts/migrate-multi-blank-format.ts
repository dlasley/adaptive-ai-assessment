/**
 * Migrate multi-blank fill-in-blank answers from space-separated to comma-separated format.
 *
 * Old format: "aimes préfère" (one word per blank, space-separated)
 * New format: "aimes, préfère" (one group per blank, comma-separated)
 *
 * Usage:
 *   npx tsx scripts/migrate-multi-blank-format.ts              # Dry run (default)
 *   npx tsx scripts/migrate-multi-blank-format.ts --apply      # Write changes to DB
 *   npx tsx scripts/migrate-multi-blank-format.ts --export out.json  # Export migration plan
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.argv.includes('--apply')
  ? (process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

interface CLIOptions {
  apply: boolean;
  exportPath?: string;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = { apply: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--apply': options.apply = true; break;
      case '--export': options.exportPath = args[++i]; break;
    }
  }
  return options;
}

interface MigrationEntry {
  id: string;
  question: string;
  blankCount: number;
  oldAnswer: string;
  newAnswer: string;
  oldVariations: string[];
  newVariations: string[];
  /** Variations extracted from slash-separated alternatives in the answer */
  extractedVariations: string[];
  status: 'migrated' | 'already_comma' | 'slash_migrated' | 'mismatch' | 'skipped';
  note: string;
}

interface ConvertResult {
  converted: string;
  extractedVariations: string[];
  status: MigrationEntry['status'];
  note: string;
}

/**
 * Convert a space-separated answer to comma-separated format.
 * Also handles slash-separated alternatives by extracting them into variations.
 */
function convertAnswer(answer: string, blankCount: number): ConvertResult {
  const trimmed = answer.trim();

  // Already has commas — likely already migrated or uses comma format
  if (trimmed.includes(',')) {
    return { converted: trimmed, extractedVariations: [], status: 'already_comma', note: 'Already contains commas' };
  }

  // Contains slash — "/" was used as a blank separator (like spaces)
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/').map(p => p.trim()).filter(Boolean);

    // If slash-part count matches blank count, treat as blank separator → comma-separated
    if (parts.length === blankCount) {
      const converted = parts.join(', ');
      return { converted, extractedVariations: [], status: 'slash_migrated', note: `Converted ${parts.length} slash-separated groups to comma-separated` };
    }

    // Part count doesn't match blank count — treat as alternatives
    const primary = parts[0];
    const alternatives = parts.slice(1);
    return {
      converted: primary,
      extractedVariations: alternatives,
      status: 'slash_migrated',
      note: `Extracted ${alternatives.length} alternative(s) from "/" into acceptable_variations (${parts.length} parts ≠ ${blankCount} blanks)`
    };
  }

  // Split on whitespace
  const words = trimmed.split(/\s+/);

  // Word count matches blank count — straightforward conversion
  if (words.length === blankCount) {
    const converted = words.join(', ');
    return { converted, extractedVariations: [], status: 'migrated', note: `Converted ${words.length} space-separated words to comma-separated` };
  }

  // Word count doesn't match blank count — can't auto-migrate
  return {
    converted: trimmed,
    extractedVariations: [],
    status: 'mismatch',
    note: `${blankCount} blanks but ${words.length} words — needs manual comma placement for multi-word-per-blank answers`
  };
}

const PAGE_SIZE = 1000;

async function main() {
  const options = parseArgs();

  console.log('Multi-Blank Format Migration');
  console.log('='.repeat(60));
  console.log(`  Mode: ${options.apply ? 'APPLY (writing to DB)' : 'DRY RUN (read-only)'}`);
  console.log();

  // Fetch all fill-in-blank questions
  let questions: Array<{
    id: string;
    question: string;
    correct_answer: string;
    acceptable_variations: string[] | null;
  }> = [];

  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('questions')
      .select('id, question, correct_answer, acceptable_variations')
      .eq('type', 'fill-in-blank')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    questions = questions.concat(data);
    page++;
  }

  console.log(`  Total fill-in-blank questions: ${questions.length}`);

  // Filter to multi-blank only
  const multiBlank = questions.filter(q => {
    const blankCount = (q.question.match(/_{3,}/g) || []).length;
    return blankCount > 1;
  });

  console.log(`  Multi-blank questions: ${multiBlank.length}`);
  console.log();

  // Process each question
  const entries: MigrationEntry[] = [];

  for (const q of multiBlank) {
    const blankCount = (q.question.match(/_{3,}/g) || []).length;
    const { converted: newAnswer, extractedVariations, status, note } = convertAnswer(q.correct_answer, blankCount);

    // Process existing variations through the same converter
    const oldVariations = q.acceptable_variations || [];
    const newVariations: string[] = [];
    for (const v of oldVariations) {
      const { converted } = convertAnswer(v, blankCount);
      newVariations.push(converted);
    }

    // For slash-migrated: merge extracted alternatives into variations (deduped)
    const allNewVariations = [...newVariations];
    if (extractedVariations.length > 0) {
      for (const ev of extractedVariations) {
        if (!allNewVariations.includes(ev)) {
          allNewVariations.push(ev);
        }
      }
    }

    entries.push({
      id: q.id,
      question: q.question,
      blankCount,
      oldAnswer: q.correct_answer,
      newAnswer,
      oldVariations,
      newVariations: allNewVariations,
      extractedVariations,
      status,
      note
    });
  }

  // Summary by status
  const counts = {
    migrated: entries.filter(e => e.status === 'migrated').length,
    already_comma: entries.filter(e => e.status === 'already_comma').length,
    slash_migrated: entries.filter(e => e.status === 'slash_migrated').length,
    mismatch: entries.filter(e => e.status === 'mismatch').length,
    skipped: entries.filter(e => e.status === 'skipped').length,
  };

  console.log('Migration Summary:');
  console.log('-'.repeat(40));
  console.log(`  Will migrate:     ${counts.migrated}`);
  console.log(`  Already comma:    ${counts.already_comma}`);
  console.log(`  Slash → vars:     ${counts.slash_migrated}`);
  console.log(`  Mismatch:         ${counts.mismatch}`);
  console.log();

  // Show migrated entries (space-separated → comma-separated)
  if (counts.migrated > 0) {
    console.log('Space → Comma Migrations:');
    console.log('-'.repeat(60));
    for (const e of entries.filter(e => e.status === 'migrated')) {
      console.log(`  ${e.id}`);
      console.log(`    Q: ${e.question.substring(0, 80)}${e.question.length > 80 ? '...' : ''}`);
      console.log(`    "${e.oldAnswer}" → "${e.newAnswer}"`);
      if (e.oldVariations.length > 0) {
        console.log(`    Variations: ${e.oldVariations.length} → updated`);
      }
    }
    console.log();
  }

  // Show slash-migrated entries (/ alternatives → acceptable_variations)
  if (counts.slash_migrated > 0) {
    console.log('Slash → Variations Migrations:');
    console.log('-'.repeat(60));
    for (const e of entries.filter(e => e.status === 'slash_migrated')) {
      console.log(`  ${e.id}`);
      console.log(`    Q: ${e.question.substring(0, 80)}${e.question.length > 80 ? '...' : ''}`);
      console.log(`    Answer: "${e.oldAnswer}" → "${e.newAnswer}"`);
      console.log(`    Extracted variations: ${e.extractedVariations.join(', ')}`);
    }
    console.log();
  }

  // Show mismatches (informational, not blocking)
  if (counts.mismatch > 0) {
    console.log('Mismatches (need manual comma placement):');
    console.log('-'.repeat(60));
    for (const e of entries.filter(e => e.status === 'mismatch')) {
      console.log(`  ${e.id}`);
      console.log(`    Q: ${e.question.substring(0, 80)}${e.question.length > 80 ? '...' : ''}`);
      console.log(`    A: ${e.oldAnswer}`);
      console.log(`    Note: ${e.note}`);
    }
    console.log();
  }

  // Export migration plan if requested
  if (options.exportPath) {
    writeFileSync(options.exportPath, JSON.stringify(entries, null, 2));
    console.log(`Migration plan exported to ${options.exportPath}\n`);
  }

  // Apply changes
  if (options.apply) {
    const toMigrate = entries.filter(e => e.status === 'migrated' || e.status === 'slash_migrated');
    if (toMigrate.length === 0) {
      console.log('Nothing to migrate.');
      return;
    }

    console.log(`Applying ${toMigrate.length} migrations (${counts.migrated} comma + ${counts.slash_migrated} slash)...`);
    let success = 0;
    let errors = 0;

    for (const e of toMigrate) {
      const { error } = await supabase
        .from('questions')
        .update({
          correct_answer: e.newAnswer,
          acceptable_variations: e.newVariations.length > 0 ? e.newVariations : null
        })
        .eq('id', e.id);

      if (error) {
        console.error(`  ERROR updating ${e.id}: ${error.message}`);
        errors++;
      } else {
        success++;
      }
    }

    console.log(`\nDone: ${success} updated, ${errors} errors`);
  } else {
    console.log('Dry run complete. Use --apply to write changes to the database.');
  }
}

main().catch(console.error);
