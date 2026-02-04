#!/usr/bin/env node
/**
 * Export writing questions from Supabase to a SQL INSERT script.
 *
 * Usage:
 *   node supabase/export-writing-questions.mjs --url <SUPABASE_URL> --key <ANON_KEY>
 *   node supabase/export-writing-questions.mjs  # reads from NEXT_PUBLIC_SUPABASE_URL/KEY env vars
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const url = getArg('--url') || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = getArg('--key') || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Error: Supabase URL and anon key required.');
  console.error('  --url <URL>  or set NEXT_PUBLIC_SUPABASE_URL');
  console.error('  --key <KEY>  or set NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

function escapeSQL(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function formatTextArray(arr) {
  if (!arr || arr.length === 0) return "'{}'::text[]";
  const items = arr.map(v => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "''") + '"').join(',');
  return "'{" + items + "}'::text[]";
}

async function main() {
  const supabase = createClient(url, key);

  console.log(`Fetching writing questions from ${url}...`);
  const { data, error } = await supabase
    .from('writing_questions')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching:', error.message);
    process.exit(1);
  }

  console.log(`Found ${data.length} writing questions.`);

  const lines = [
    '-- Writing Questions Seed Data',
    `-- Exported from Supabase on ${new Date().toISOString().split('T')[0]}`,
    `-- ${data.length} questions`,
    '',
    'INSERT INTO writing_questions (id, question_en, correct_answer_fr, acceptable_variations, topic, difficulty, question_type, explanation, hints, requires_complete_sentence, unit_id, created_at, updated_at) VALUES',
  ];

  const valueRows = data.map((q) => {
    return '  (' + [
      escapeSQL(q.id),
      escapeSQL(q.question_en),
      escapeSQL(q.correct_answer_fr),
      formatTextArray(q.acceptable_variations),
      escapeSQL(q.topic),
      escapeSQL(q.difficulty),
      escapeSQL(q.question_type),
      escapeSQL(q.explanation),
      formatTextArray(q.hints),
      q.requires_complete_sentence ? 'TRUE' : 'FALSE',
      escapeSQL(q.unit_id),
      escapeSQL(q.created_at),
      escapeSQL(q.updated_at),
    ].join(', ') + ')';
  });

  lines.push(valueRows.join(',\n'));
  lines.push('ON CONFLICT (id) DO NOTHING;');
  lines.push('');

  const outPath = resolve(__dirname, 'seed-writing-questions.sql');
  writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`Written to ${outPath}`);
}

main();
