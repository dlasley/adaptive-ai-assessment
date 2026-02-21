/**
 * Test Database Connection
 * Verifies Supabase connectivity and schema for all core tables
 *
 * Run with: npx tsx scripts/test-db-connection.ts
 */

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// Load environment variables
config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

console.log('🧪 Testing Database Connection\n');
console.log('Configuration:');
console.log(`  URL: ${supabaseUrl ? '✓ Set' : '✗ Missing'}`);
console.log(`  Key: ${supabaseKey ? '✓ Set' : '✗ Missing'}`);
console.log('');

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in .env.local');
  console.log('\nAdd these to .env.local:');
  console.log('  NEXT_PUBLIC_SUPABASE_URL=your_url');
  console.log('  NEXT_PUBLIC_SUPABASE_ANON_KEY=your_key');
  process.exit(1);
}

async function testConnection() {
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('Testing database connection...\n');

  try {
    // Test 1: Check tables exist
    console.log('Test 1: Checking study_codes table...');
    const { data: tables, error: tablesError } = await supabase
      .from('study_codes')
      .select('id')
      .limit(1);

    if (tablesError) {
      console.error('❌ Tables not found. Did you run schema.sql?');
      console.error('Error:', tablesError.message);
      return false;
    }
    console.log('✅ study_codes table exists\n');

    // Test 2: Generate study code
    console.log('Test 2: Creating test study code...');
    // Generate proper format: study-xxxxxxxx (8 alphanumeric chars)
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let testCode = 'study-';
    for (let i = 0; i < 8; i++) {
      testCode += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const { data: codeData, error: codeError } = await supabase
      .from('study_codes')
      .insert({ code: testCode, display_name: 'Test Student' })
      .select()
      .single();

    if (codeError) {
      console.error('❌ Failed to create study code');
      console.error('Error:', codeError.message);
      return false;
    }
    console.log('✅ Created study code:', testCode);
    console.log('   ID:', codeData.id);
    console.log('');

    // Test 3: Insert quiz history
    console.log('Test 3: Recording quiz history...');
    const { data: quizData, error: quizError } = await supabase
      .from('quiz_history')
      .insert({
        study_code_id: codeData.id,
        unit_id: 'introduction',
        difficulty: 'beginner',
        total_questions: 10,
        correct_answers: 8,
        score_percentage: 80.0,
      })
      .select()
      .single();

    if (quizError) {
      console.error('❌ Failed to create quiz history');
      console.error('Error:', quizError.message);
      return false;
    }
    console.log('✅ Saved quiz history');
    console.log('   Score: 80%');
    console.log('');

    // Test 4: Insert question results
    console.log('Test 4: Recording question results...');
    const { error: resultsError } = await supabase
      .from('question_results')
      .insert([
        {
          quiz_history_id: quizData.id,
          study_code_id: codeData.id,
          question_id: 'test_q1',
          topic: 'Greetings',
          difficulty: 'beginner',
          is_correct: true,
          user_answer: 'Bonjour',
          correct_answer: 'Bonjour',
        },
        {
          quiz_history_id: quizData.id,
          study_code_id: codeData.id,
          question_id: 'test_q2',
          topic: 'Greetings',
          difficulty: 'beginner',
          is_correct: false,
          user_answer: 'Au revoir',
          correct_answer: 'Salut',
        },
      ]);

    if (resultsError) {
      console.error('❌ Failed to save question results');
      console.error('Error:', resultsError.message);
      return false;
    }
    console.log('✅ Saved question results');
    console.log('');

    // Test 5: Query concept mastery view
    console.log('Test 5: Checking concept_mastery view...');
    const { data: masteryData, error: masteryError } = await supabase
      .from('concept_mastery')
      .select('*')
      .eq('study_code_id', codeData.id);

    if (masteryError) {
      console.error('❌ Failed to query concept mastery');
      console.error('Error:', masteryError.message);
      return false;
    }
    console.log('✅ concept_mastery view working');
    console.log('   Topics tracked:', masteryData.length);
    console.log('');

    // Test 6: Check questions table
    console.log('Test 6: Checking questions table...');
    const { data: questions, error: questionsError, count } = await supabase
      .from('questions')
      .select('id, type, topic', { count: 'exact' })
      .limit(5);

    if (questionsError) {
      console.error('❌ Failed to query questions table');
      console.error('Error:', questionsError.message);
      return false;
    }
    console.log('✅ questions table accessible');
    console.log(`   Total questions: ${count || questions?.length || 0}`);
    console.log('');

    // Cleanup: Delete test data
    console.log('Cleaning up test data...');
    await supabase.from('study_codes').delete().eq('id', codeData.id);
    console.log('✅ Test data cleaned up\n');

    return true;
  } catch (error: any) {
    console.error('❌ Unexpected error:', error.message);
    return false;
  }
}

testConnection().then((success) => {
  if (success) {
    console.log('🎉 All tests passed!');
    console.log('\nDatabase is properly configured and ready to use.');
  } else {
    console.log('\n❌ Some tests failed.');
    console.log('Check the error messages above and:');
    console.log('  1. Verify your Supabase credentials');
    console.log('  2. Make sure you ran schema.sql in SQL Editor');
    console.log('  3. Check Supabase dashboard for any issues');
  }
  process.exit(success ? 0 : 1);
});
