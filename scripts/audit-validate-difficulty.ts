/**
 * Post-generation difficulty validation pass.
 * Evaluates each question with Haiku using a concrete rubric
 * and relabels where the AI disagrees with the generation label.
 *
 * Output goes to stdout — redirect to a log file for monitoring.
 * Uses SUPABASE_SECRET_KEY for update permissions.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { MODELS } from './lib/config';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
);

interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  options: string[] | null;
}

const RUBRIC = `You are a French 1 difficulty classifier. Classify each question as exactly one of: beginner, intermediate, advanced.

RUBRIC:
- **Beginner**: Tests ONE isolated fact or form. Single-word or single-form answer. Vocabulary recall, simple translation of 1-3 words, single verb conjugation with no context, basic true/false about a single fact.
  Examples: "What does 'bonjour' mean?", "Conjugate 'danser' for 'je'", "True or false: 'chat' means 'cat'"

- **Intermediate**: Tests ONE grammar rule applied in a sentence-level context. Answer is a short phrase or sentence. Fill-in-blank requiring correct form in context, translation of a complete sentence with one grammar point, MCQ requiring grammatical reasoning.
  Examples: "Nous _____ une comédie avec nos amis." (voyons), "Translate: 'We don't like swimming.'", choosing between "Je suis faim" vs "J'ai faim"

- **Advanced**: Tests TWO or more concepts combined, OR requires multi-sentence production, OR has multiple blanks. Answer requires integrating multiple grammar rules or producing extended output.
  Examples: "Write three sentences using different pronouns with 'aimer'", "Fill in TWO blanks: Après le sport, nous _____ et nous _____", questions requiring partitive + negation together

KEY RULES:
- If a question tests only ONE concept with a short answer, it is NOT advanced — even if the vocabulary is uncommon.
- A single verb conjugation (even irregular) with no sentence context = beginner.
- A single sentence with one grammar rule applied = intermediate.
- Multiple blanks, multiple sentences, or two grammar concepts combined = advanced.

Respond with ONLY the difficulty level: beginner, intermediate, or advanced.`;

const PAGE_SIZE = 1000;

async function fetchAllQuestions(): Promise<QuestionRow[]> {
  let all: QuestionRow[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('questions')
      .select('id, question, correct_answer, type, difficulty, topic, unit_id, options')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data as QuestionRow[]);
    page++;
  }
  return all;
}

async function classifyQuestion(q: QuestionRow): Promise<string> {
  const questionDesc = q.type === 'multiple-choice' && q.options
    ? `${q.question}\nOptions: ${q.options.join(' / ')}\nAnswer: ${q.correct_answer}`
    : `${q.question}\nAnswer: ${q.correct_answer}`;

  const response = await anthropic.messages.create({
    model: MODELS.questionGenerationStructured,
    max_tokens: 20,
    messages: [
      { role: 'user', content: `${RUBRIC}\n\nQuestion (${q.type}, topic: ${q.topic}):\n${questionDesc}` },
    ],
  });

  const text = (response.content[0] as { type: 'text'; text: string }).text.trim().toLowerCase();
  // Extract just the difficulty word
  if (text.includes('beginner')) return 'beginner';
  if (text.includes('intermediate')) return 'intermediate';
  if (text.includes('advanced')) return 'advanced';
  return text;
}

async function main() {
  console.log('Fetching all questions...');
  const questions = await fetchAllQuestions();
  console.log(`Found ${questions.length} questions.\n`);

  let changed = 0;
  let unchanged = 0;
  let errors = 0;
  const changes: Record<string, Record<string, number>> = {
    beginner: { beginner: 0, intermediate: 0, advanced: 0 },
    intermediate: { beginner: 0, intermediate: 0, advanced: 0 },
    advanced: { beginner: 0, intermediate: 0, advanced: 0 },
  };

  // Process in batches of 10 concurrent
  const BATCH = 10;
  for (let i = 0; i < questions.length; i += BATCH) {
    const batch = questions.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (q) => {
        const newDiff = await classifyQuestion(q);
        if (!['beginner', 'intermediate', 'advanced'].includes(newDiff)) {
          console.error(`  ⚠️  Unexpected response for ${q.id}: "${newDiff}"`);
          errors++;
          return;
        }
        changes[q.difficulty][newDiff]++;
        if (newDiff !== q.difficulty) {
          const { error } = await supabase
            .from('questions')
            .update({ difficulty: newDiff })
            .eq('id', q.id);
          if (error) {
            console.error(`  ❌ Update error for ${q.id}: ${error.message}`);
            errors++;
          } else {
            changed++;
          }
        } else {
          unchanged++;
        }
      }),
    );

    const failCount = results.filter(r => r.status === 'rejected').length;
    if (failCount > 0) {
      errors += failCount;
      results.filter(r => r.status === 'rejected').forEach(r => {
        console.error(`  ❌ ${(r as PromiseRejectedResult).reason}`);
      });
    }

    const pct = Math.round(((i + batch.length) / questions.length) * 100);
    process.stdout.write(`\r  Progress: ${i + batch.length}/${questions.length} (${pct}%) — ${changed} changed, ${unchanged} unchanged, ${errors} errors`);
  }

  console.log('\n\n═══════════════════════════════════════════════');
  console.log('DIFFICULTY VALIDATION COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Total:     ${questions.length}`);
  console.log(`  Changed:   ${changed} (${(changed / questions.length * 100).toFixed(1)}%)`);
  console.log(`  Unchanged: ${unchanged}`);
  console.log(`  Errors:    ${errors}`);
  console.log();
  console.log('Confusion matrix (rows=original, cols=validated):');
  console.log('              beginner  intermediate  advanced');
  for (const orig of ['beginner', 'intermediate', 'advanced']) {
    const row = changes[orig];
    console.log(`  ${orig.padEnd(14)} ${String(row.beginner).padStart(6)}  ${String(row.intermediate).padStart(12)}  ${String(row.advanced).padStart(8)}`);
  }

  // Final distribution
  console.log();
  const finalDist: Record<string, number> = { beginner: 0, intermediate: 0, advanced: 0 };
  for (const orig of ['beginner', 'intermediate', 'advanced']) {
    for (const dest of ['beginner', 'intermediate', 'advanced']) {
      finalDist[dest] += changes[orig][dest];
    }
  }
  console.log('Final distribution:');
  for (const [k, v] of Object.entries(finalDist)) {
    console.log(`  ${k}: ${v} (${(v / questions.length * 100).toFixed(1)}%)`);
  }
}

main().catch(console.error);
