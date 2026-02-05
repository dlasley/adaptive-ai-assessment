/**
 * Check Questions in Database
 * Unified script to verify and inspect questions in the database
 *
 * Usage: npx tsx scripts/check-writing-questions.ts [--samples]
 *   --samples  Show sample question text from each type
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

const showSamples = process.argv.includes('--samples');

interface Question {
  id: string;
  unit_id: string;
  difficulty: string;
  type: string;
  writing_type: string | null;
  topic: string;
  question: string;
  correct_answer: string;
}

async function checkQuestions() {
  console.log('🔍 Checking questions in database...\n');

  try {
    // Get all questions
    const { data: all, error: allError } = await supabase
      .from('questions')
      .select('id, unit_id, difficulty, type, writing_type, topic, question, correct_answer');

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

    const questions = all as Question[];
    console.log(`✅ Total questions: ${questions.length}\n`);

    // Count by unit
    const byUnit = questions.reduce((acc, q) => {
      acc[q.unit_id] = acc[q.unit_id] || {};
      acc[q.unit_id][q.type] = (acc[q.unit_id][q.type] || 0) + 1;
      return acc;
    }, {} as Record<string, Record<string, number>>);

    console.log('📦 By Unit & Type:');
    for (const [unit, types] of Object.entries(byUnit)) {
      const total = Object.values(types).reduce((a, b) => a + b, 0);
      console.log(`  ${unit}: ${total} total`);
      for (const [type, count] of Object.entries(types)) {
        console.log(`    ${type}: ${count}`);
      }
    }

    // Count by question type (MCQ, T/F, fill-in-blank, writing)
    const byType = questions.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n📝 By Question Type:');
    Object.entries(byType).forEach(([type, count]) => {
      console.log(`  ${type}: ${count} questions`);
    });

    // Count by difficulty
    const byDifficulty = questions.reduce((acc, q) => {
      acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('\n📊 By Difficulty:');
    Object.entries(byDifficulty).forEach(([difficulty, count]) => {
      console.log(`  ${difficulty}: ${count} questions`);
    });

    // Count writing questions by writing_type
    const writingQuestions = questions.filter(q => q.type === 'writing');
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
    const byTopic = questions.reduce((acc, q) => {
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

    // Show sample questions if requested
    if (showSamples) {
      console.log('\n' + '='.repeat(60));
      console.log('SAMPLE QUESTIONS');
      console.log('='.repeat(60));

      const types = ['multiple-choice', 'true-false', 'fill-in-blank', 'writing'];
      for (const type of types) {
        const samples = questions.filter(q => q.type === type).slice(0, 2);
        if (samples.length === 0) continue;

        console.log(`\n--- ${type.toUpperCase()} ---`);
        samples.forEach((q, i) => {
          console.log(`${i + 1}. [${q.unit_id}/${q.difficulty}] ${q.topic}`);
          const questionText = q.question.length > 100
            ? q.question.substring(0, 100) + '...'
            : q.question;
          console.log(`   Q: ${questionText}`);
          const answerText = q.correct_answer.length > 80
            ? q.correct_answer.substring(0, 80) + '...'
            : q.correct_answer;
          console.log(`   A: ${answerText}`);
        });
      }
    } else {
      console.log('\n💡 Run with --samples to see sample question text');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

checkQuestions();
