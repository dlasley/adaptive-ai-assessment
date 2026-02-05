/**
 * One-time script to generate and save initial writing questions
 *
 * Usage:
 *   npx tsx scripts/generate-initial-questions.ts
 *
 * This script:
 * 1. Generates 50 diverse French writing questions using Claude
 * 2. Saves them to the unified 'questions' table in Supabase
 * 3. Provides a summary of created questions
 *
 * Note: For regular question generation, use generate-questions.ts instead.
 * This script is for initial seeding or bulk writing question generation.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

// Load environment variables from .env.local
config({ path: resolve(__dirname, '../.env.local') });

// Initialize Supabase
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Anthropic
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

interface WritingQuestion {
  question_en: string;
  correct_answer_fr: string | null;
  acceptable_variations: string[];
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  question_type: 'translation' | 'conjugation' | 'open_ended' | 'question_formation' | 'sentence_building';
  explanation: string;
  hints: string[];
  requires_complete_sentence: boolean;
}

async function generateQuestions(count: number): Promise<WritingQuestion[]> {
  const prompt = `Generate exactly ${count} French writing practice questions for students learning French.

Requirements:
- Difficulty distribution: Mix of beginner (40%), intermediate (30%), advanced (30%)
- Diverse topics covering: greetings, verb conjugations (être, avoir, -er verbs, irregular verbs),
  daily routines, food and preferences, time and calendar, question formation,
  personal expression and opinions, describing people/places/things

Question Types:
1. **Simple Translation** (beginner): "How do you say 'X' in French?"
2. **Verb Conjugation** (beginner/intermediate): "Conjugate 'verb' in tense, person"
3. **Sentence Translation** (intermediate): "Translate: [English sentence]"
4. **Open-Ended Personal** (intermediate/advanced): Questions requiring creative, complete sentence responses
5. **Question Formation** (intermediate): "How do you ask 'X' in French?"
6. **Sentence Building** (intermediate/advanced): Construct sentences with specific grammar structures

IMPORTANT Guidelines:
- For beginner: Focus on single words, basic phrases, simple conjugations
- For intermediate: Require complete sentences, basic tenses, common expressions
- For advanced: Require 2-3 sentence responses, complex tenses, personal opinions
- Open-ended questions should accept multiple correct answers
- Provide helpful hints that guide without giving away answers
- Include practical, real-world contexts students can relate to

For each question, provide:
- question_en: The English prompt/question
- correct_answer_fr: ONE example correct answer (or null for very open-ended questions)
- acceptable_variations: Array of 2-5 alternative acceptable answers (empty for open-ended)
- topic: Category (e.g., "greetings", "food", "daily_routine", "verb_conjugation:être")
- difficulty: "beginner", "intermediate", or "advanced"
- question_type: One of: "translation", "conjugation", "open_ended", "question_formation", "sentence_building"
- explanation: Brief explanation of the grammar/concept being practiced (in English)
- hints: Array of 1-3 helpful hints
- requires_complete_sentence: true if answer must be a complete sentence

Return ONLY a valid JSON array with no markdown formatting or code blocks:
[
  {
    "question_en": "How do you say 'hello' in French?",
    "correct_answer_fr": "bonjour",
    "acceptable_variations": ["salut", "allô"],
    "topic": "greetings",
    "difficulty": "beginner",
    "question_type": "translation",
    "explanation": "Basic greeting in French - 'bonjour' is formal, 'salut' is informal",
    "hints": ["This is the most common French greeting", "It starts with 'b'"],
    "requires_complete_sentence": false
  }
]`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    temperature: 0.8,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  const textContent = response.content[0];
  if (textContent.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  // Strip markdown code blocks if present
  let jsonText = textContent.text.trim();
  if (jsonText.startsWith('```')) {
    // Remove opening ```json or ``` and closing ```
    jsonText = jsonText.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
  }

  const questions = JSON.parse(jsonText) as WritingQuestion[];

  if (!Array.isArray(questions)) {
    throw new Error('Invalid response format');
  }

  return questions;
}

async function saveQuestionsToDatabase(questions: WritingQuestion[]): Promise<void> {
  console.log(`\n💾 Saving ${questions.length} questions to database...`);

  // Map to unified questions table schema
  const questionsToInsert = questions.map(q => ({
    question: q.question_en,
    correct_answer: q.correct_answer_fr || '',
    acceptable_variations: q.acceptable_variations,
    topic: q.topic,
    difficulty: q.difficulty,
    type: 'writing' as const,  // All questions from this script are writing type
    writing_type: q.question_type,
    explanation: q.explanation,
    hints: q.hints,
    requires_complete_sentence: q.requires_complete_sentence,
    unit_id: 'all', // Applies to all units
  }));

  const { data, error } = await supabase
    .from('questions')
    .insert(questionsToInsert)
    .select();

  if (error) {
    console.error('❌ Error saving questions:', error);
    throw error;
  }

  console.log(`✅ Successfully saved ${data?.length || 0} questions to database`);
}

function printSummary(questions: WritingQuestion[]): void {
  console.log('\n📊 Question Summary:');
  console.log('─'.repeat(50));

  // Count by difficulty
  const byDifficulty = questions.reduce((acc, q) => {
    acc[q.difficulty] = (acc[q.difficulty] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\n📈 By Difficulty:');
  Object.entries(byDifficulty).forEach(([level, count]) => {
    console.log(`  ${level.padEnd(15)}: ${count} questions`);
  });

  // Count by type
  const byType = questions.reduce((acc, q) => {
    acc[q.question_type] = (acc[q.question_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\n📝 By Type:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type.padEnd(20)}: ${count} questions`);
  });

  // Count by topic (top 10)
  const byTopic = questions.reduce((acc, q) => {
    acc[q.topic] = (acc[q.topic] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log('\n🎯 Top Topics:');
  Object.entries(byTopic)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([topic, count]) => {
      console.log(`  ${topic.padEnd(25)}: ${count} questions`);
    });

  // Count complete sentence requirements
  const requiresSentence = questions.filter(q => q.requires_complete_sentence).length;
  console.log(`\n✍️  Require Complete Sentences: ${requiresSentence}/${questions.length}`);
}

async function main() {
  console.log('🚀 Starting question generation process...');
  console.log('─'.repeat(50));

  try {
    // Generate questions in batches to avoid JSON parsing issues
    const allQuestions: WritingQuestion[] = [];
    const batchSize = 10;
    const totalQuestions = 50;
    const batches = Math.ceil(totalQuestions / batchSize);

    for (let i = 0; i < batches; i++) {
      console.log(`\n📦 Generating batch ${i + 1}/${batches}...`);
      const questions = await generateQuestions(batchSize);
      allQuestions.push(...questions);
      console.log(`   Added ${questions.length} questions (Total: ${allQuestions.length})`);

      // Small delay between batches to avoid rate limits
      if (i < batches - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Print summary
    printSummary(allQuestions);

    // Save to database
    await saveQuestionsToDatabase(allQuestions);

    console.log('\n✨ Success! Questions have been generated and saved.');
    console.log('\n💡 Next steps:');
    console.log('   1. Review questions in your Supabase dashboard');
    console.log('   2. Update writing-test page to load from database');
    console.log('   3. Test the questions with students');
    console.log('');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
main();
