/**
 * Quality audit for advanced written questions.
 * Uses Sonnet to evaluate Haiku-generated questions for:
 * - Answer correctness
 * - French grammar correctness
 * - Hallucination (fabricated vocab, rules, or cultural facts)
 * - Question coherence (does the question make sense?)
 *
 * Output: /tmp/french-quality-audit.log
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const EVALUATOR_MODEL = 'claude-sonnet-4-5-20250929';

interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  writing_type: string | null;
}

interface AuditResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  question: string;
  answer: string;
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  notes: string;
}

const AUDIT_PROMPT = `You are a French language expert auditing quiz questions for a French 1 (beginner) course.

For each question, evaluate these 4 criteria:

1. **answer_correct**: Is the provided correct answer actually correct? Would a French teacher accept it?
2. **grammar_correct**: Is the French in both the question AND answer grammatically correct? (Accents, agreements, conjugations, articles)
3. **no_hallucination**: Is everything factually accurate? No made-up vocabulary, fabricated grammar rules, incorrect cultural facts, or nonexistent French words?
4. **question_coherent**: Does the question make sense as a quiz question? Is it unambiguous? Would a student understand what's being asked?

Respond in this exact JSON format (no markdown, no code fences):
{"answer_correct": true/false, "grammar_correct": true/false, "no_hallucination": true/false, "question_coherent": true/false, "notes": "brief explanation of any issues found, or 'OK' if all pass"}`;

const PAGE_SIZE = 1000;

async function fetchAdvancedWritten(): Promise<QuestionRow[]> {
  let all: QuestionRow[] = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase
      .from('questions')
      .select('id, question, correct_answer, type, difficulty, topic, unit_id, writing_type')
      .eq('difficulty', 'advanced')
      .in('type', ['fill-in-blank', 'writing'])
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data as QuestionRow[]);
    page++;
  }
  return all;
}

async function auditQuestion(q: QuestionRow): Promise<AuditResult> {
  const prompt = `${AUDIT_PROMPT}

Question type: ${q.type}${q.writing_type ? ` (${q.writing_type})` : ''}
Topic: ${q.topic}
Difficulty: ${q.difficulty}

Question: ${q.question}
Correct answer: ${q.correct_answer}`;

  const response = await anthropic.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = (response.content[0] as { type: 'text'; text: string }).text.trim();

  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(cleaned);
    return {
      id: q.id,
      topic: q.topic,
      type: q.type,
      writing_type: q.writing_type,
      question: q.question,
      answer: q.correct_answer,
      answer_correct: parsed.answer_correct,
      grammar_correct: parsed.grammar_correct,
      no_hallucination: parsed.no_hallucination,
      question_coherent: parsed.question_coherent,
      notes: parsed.notes || '',
    };
  } catch {
    return {
      id: q.id,
      topic: q.topic,
      type: q.type,
      writing_type: q.writing_type,
      question: q.question,
      answer: q.correct_answer,
      answer_correct: false,
      grammar_correct: false,
      no_hallucination: false,
      question_coherent: false,
      notes: `PARSE ERROR: ${text.substring(0, 200)}`,
    };
  }
}

async function main() {
  console.log('Fetching advanced written questions...');
  const questions = await fetchAdvancedWritten();
  console.log(`Found ${questions.length} advanced written questions.\n`);

  const results: AuditResult[] = [];
  const BATCH = 5; // Sonnet is slower, use smaller batch

  for (let i = 0; i < questions.length; i += BATCH) {
    const batch = questions.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(q => auditQuestion(q)),
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error(`  Error: ${r.reason}`);
      }
    }

    const pct = Math.round(((i + batch.length) / questions.length) * 100);
    process.stdout.write(`\r  Progress: ${i + batch.length}/${questions.length} (${pct}%)`);
  }

  console.log('\n');

  // Summary
  const flagged = results.filter(r =>
    !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent
  );

  console.log('═'.repeat(60));
  console.log('QUALITY AUDIT COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  Total evaluated: ${results.length}`);
  console.log(`  All pass:        ${results.length - flagged.length} (${((results.length - flagged.length) / results.length * 100).toFixed(1)}%)`);
  console.log(`  Flagged:         ${flagged.length} (${(flagged.length / results.length * 100).toFixed(1)}%)`);
  console.log();

  // Breakdown by criterion
  const answerFail = results.filter(r => !r.answer_correct).length;
  const grammarFail = results.filter(r => !r.grammar_correct).length;
  const hallucinationFail = results.filter(r => !r.no_hallucination).length;
  const coherenceFail = results.filter(r => !r.question_coherent).length;

  console.log('Failures by criterion:');
  console.log(`  Answer incorrect:    ${answerFail} (${(answerFail / results.length * 100).toFixed(1)}%)`);
  console.log(`  Grammar incorrect:   ${grammarFail} (${(grammarFail / results.length * 100).toFixed(1)}%)`);
  console.log(`  Hallucination:       ${hallucinationFail} (${(hallucinationFail / results.length * 100).toFixed(1)}%)`);
  console.log(`  Incoherent:          ${coherenceFail} (${(coherenceFail / results.length * 100).toFixed(1)}%)`);

  // Show flagged questions
  if (flagged.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('FLAGGED QUESTIONS');
    console.log('─'.repeat(60));

    for (const f of flagged) {
      const flags = [];
      if (!f.answer_correct) flags.push('ANSWER');
      if (!f.grammar_correct) flags.push('GRAMMAR');
      if (!f.no_hallucination) flags.push('HALLUCINATION');
      if (!f.question_coherent) flags.push('INCOHERENT');

      console.log(`\n  [${flags.join(', ')}] ${f.type}${f.writing_type ? '/' + f.writing_type : ''} | ${f.topic}`);
      console.log(`  Q: ${f.question}`);
      console.log(`  A: ${f.answer}`);
      console.log(`  Notes: ${f.notes}`);
    }
  }

  // By type breakdown
  console.log('\n' + '─'.repeat(60));
  console.log('PASS RATE BY TYPE');
  console.log('─'.repeat(60));
  const types = [...new Set(results.map(r => r.type))];
  for (const t of types) {
    const typeResults = results.filter(r => r.type === t);
    const typePass = typeResults.filter(r =>
      r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent
    ).length;
    console.log(`  ${t}: ${typePass}/${typeResults.length} pass (${(typePass / typeResults.length * 100).toFixed(1)}%)`);
  }
}

main().catch(console.error);
