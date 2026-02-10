/**
 * Check Questions in Database
 * Unified script to verify and inspect questions in the database
 *
 * Usage: npx tsx scripts/check-writing-questions.ts [--samples]
 *   --samples  Show sample question text from each type
 */

import { createScriptSupabase, fetchAllQuestions, analyzeDistribution } from './lib/db-queries';

const supabase = createScriptSupabase();

const showSamples = process.argv.includes('--samples');

async function checkQuestions() {
  console.log('🔍 Checking questions in database...\n');

  try {
    const questions = await fetchAllQuestions(
      supabase,
      'id, unit_id, difficulty, type, writing_type, topic, question, correct_answer',
    );

    if (questions.length === 0) {
      console.log('⚠️  No questions found in database!');
      console.log('\nTo add questions, run:');
      console.log('  npx tsx scripts/generate-questions.ts --sync-db');
      return;
    }

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

    // Type and writing subtype distribution (shared analysis)
    const dist = analyzeDistribution(questions);

    console.log('\n📝 By Question Type:');
    Object.entries(dist.byType).forEach(([type, count]) => {
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

    if (dist.writingTotal > 0) {
      console.log('\n✍️  Writing Questions by Subtype:');
      Object.entries(dist.byWritingType).forEach(([type, count]) => {
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
          const questionText = (q.question || '').length > 100
            ? (q.question || '').substring(0, 100) + '...'
            : q.question || '';
          console.log(`   Q: ${questionText}`);
          const answerText = (q.correct_answer || '').length > 80
            ? (q.correct_answer || '').substring(0, 80) + '...'
            : q.correct_answer || '';
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
