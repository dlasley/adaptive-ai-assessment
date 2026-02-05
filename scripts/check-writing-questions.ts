/**
 * Check Questions in Database
 * Quick script to verify questions are in the unified questions table
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

async function checkQuestions() {
  console.log('🔍 Checking questions in database...\n');

  try {
    // Get all questions
    const { data: all, error: allError } = await supabase
      .from('questions')
      .select('id, difficulty, type, writing_type, topic');

    if (allError) {
      console.error('❌ Error fetching questions:', allError);
      return;
    }

    if (!all || all.length === 0) {
      console.log('⚠️  No questions found in database!');
      console.log('\nTo add questions, run:');
      console.log('  npx tsx scripts/generate-questions.ts --sync-db');
      return;
    }

    console.log(`✅ Total questions: ${all.length}\n`);

    // Count by question type (MCQ, T/F, fill-in-blank, writing)
    const byType = all.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('📝 By Question Type:');
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count} questions`);
    });

    // Count by difficulty
    const byDifficulty = all.reduce((acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n📊 By Difficulty:');
    Object.entries(byDifficulty).forEach(([difficulty, count]) => {
      console.log(`  ${difficulty}: ${count} questions`);
    });

    // Count writing questions by writing_type
    const writingQuestions = all.filter(q => q.type === 'writing');
    if (writingQuestions.length > 0) {
      const byWritingType = writingQuestions.reduce((acc, q) => {
        const wType = q.writing_type || 'unspecified';
        acc[wType] = (acc[wType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log('\n✍️  Writing Questions by Subtype:');
      Object.entries(byWritingType).forEach(([type, count]) => {
        console.log(`  ${type}: ${count} questions`);
      });
    }

    // Count by topic (top 10)
    const byTopic = all.reduce((acc, q) => {
      acc[q.topic] = (acc[q.topic] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n🎯 Top 10 Topics:');
    Object.entries(byTopic)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .forEach(([topic, count]) => {
        console.log(`  ${topic}: ${count} questions`);
      });

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkQuestions();
