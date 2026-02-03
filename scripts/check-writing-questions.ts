/**
 * Check Writing Questions in Database
 * Quick script to verify writing questions are in the database
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
config({ path: resolve(__dirname, '../.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('❌ Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function checkWritingQuestions() {
  console.log('🔍 Checking writing questions in database...\n');

  try {
    // Get count by difficulty
    const { data: all, error: allError } = await supabase
      .from('writing_questions')
      .select('id, difficulty, question_type');

    if (allError) {
      console.error('❌ Error fetching writing questions:', allError);
      return;
    }

    if (!all || all.length === 0) {
      console.log('⚠️  No writing questions found in database!');
      console.log('\nTo add writing questions, run:');
      console.log('  npx tsx scripts/generate-initial-questions.ts');
      return;
    }

    console.log(`✅ Total writing questions: ${all.length}\n`);

    // Count by difficulty
    const byDifficulty = all.reduce((acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('📊 By Difficulty:');
    Object.entries(byDifficulty).forEach(([difficulty, count]) => {
      console.log(`  ${difficulty}: ${count} questions`);
    });

    // Count by question type
    const byType = all.reduce((acc, q) => {
      acc[q.question_type] = (acc[q.question_type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n📝 By Type:');
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count} questions`);
    });

    // Show sample questions
    console.log('\n📋 Sample Questions:');
    const samples = all.slice(0, 3);
    samples.forEach((q, idx) => {
      console.log(`\n${idx + 1}. [${q.difficulty}] ${q.question_type}`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkWritingQuestions();
