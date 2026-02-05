import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const { data: questions, error } = await supabase
  .from('questions')
  .select('unit_id, type, question, correct_answer, topic, difficulty');

if (error) {
  console.error('Error:', error);
  process.exit(1);
}

// Count by unit and type
const counts = {};
questions.forEach(q => {
  if (!counts[q.unit_id]) counts[q.unit_id] = {};
  counts[q.unit_id][q.type] = (counts[q.unit_id][q.type] || 0) + 1;
});

console.log('=== QUESTION COUNTS BY UNIT & TYPE ===\n');
for (const [unit, types] of Object.entries(counts)) {
  console.log(unit + ':');
  for (const [type, count] of Object.entries(types)) {
    console.log('  ' + type + ': ' + count);
  }
}

// Sample questions from each type
console.log('\n=== SAMPLE QUESTIONS ===\n');

const types = ['multiple-choice', 'true-false', 'fill-in-blank', 'writing'];
for (const type of types) {
  const samples = questions.filter(q => q.type === type).slice(0, 2);

  console.log('--- ' + type.toUpperCase() + ' ---');
  samples.forEach((q, i) => {
    console.log((i+1) + '. [' + q.unit_id + '/' + q.difficulty + '] ' + q.topic);
    console.log('   Q: ' + q.question.substring(0, 100) + (q.question.length > 100 ? '...' : ''));
    console.log('   A: ' + q.correct_answer.substring(0, 80));
    console.log();
  });
}

console.log('\nTotal questions:', questions.length);
