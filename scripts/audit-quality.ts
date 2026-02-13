/**
 * Quality audit for quiz questions.
 * Uses Sonnet to evaluate generated questions for:
 * - Answer correctness
 * - French grammar correctness
 * - Hallucination (fabricated vocab, rules, or cultural facts)
 * - Question coherence (genuinely nonsensical or unanswerable)
 *
 * Usage:
 *   npx tsx scripts/audit-quality.ts                          # Audit all questions
 *   npx tsx scripts/audit-quality.ts --unit unit-2            # Filter by unit
 *   npx tsx scripts/audit-quality.ts --difficulty advanced     # Filter by difficulty
 *   npx tsx scripts/audit-quality.ts --type writing           # Filter by question type
 *   npx tsx scripts/audit-quality.ts --model claude-haiku-4-5-20251001  # Filter by generator model
 *   npx tsx scripts/audit-quality.ts --limit 50               # Random sample of N questions
 *   npx tsx scripts/audit-quality.ts --batch batch_xyz        # Filter by batch_id
 *   npx tsx scripts/audit-quality.ts --write-db --unit unit-2 # Write quality_status to DB
 *   npx tsx scripts/audit-quality.ts --write-db --pending-only # Audit only pending questions
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use secret key when --write-db/--mark-db is set (needs write access); anon key for read-only audits
const useSecretKey = process.argv.includes('--write-db') || process.argv.includes('--mark-db');
const supabaseKey = useSecretKey
  ? (process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (useSecretKey && !process.env.SUPABASE_SECRET_KEY) {
  console.warn('⚠️  --write-db requires SUPABASE_SECRET_KEY for write access. Falling back to anon key.');
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  supabaseKey,
);

const EVALUATOR_MODEL = 'claude-sonnet-4-5-20250929';

interface CLIOptions {
  unitId?: string;
  difficulty?: string;
  type?: string;
  model?: string;
  limit?: number;
  batchId?: string;
  markDb?: boolean;
  pendingOnly?: boolean;
}

function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--unit': options.unitId = args[++i]; break;
      case '--difficulty': options.difficulty = args[++i]; break;
      case '--type': options.type = args[++i]; break;
      case '--model': options.model = args[++i]; break;
      case '--limit': options.limit = parseInt(args[++i], 10); break;
      case '--batch': options.batchId = args[++i]; break;
      case '--write-db': options.markDb = true; break;
      case '--mark-db':
        console.warn('⚠️  --mark-db is deprecated, use --write-db instead');
        options.markDb = true;
        break;
      case '--pending-only': options.pendingOnly = true; break;
    }
  }
  return options;
}

interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  type: string;
  difficulty: string;
  topic: string;
  unit_id: string;
  writing_type: string | null;
  generated_by: string | null;
  options: string[] | null;
}

interface AuditResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  notes: string;
}

const AUDIT_PROMPT = `You are a French language expert auditing quiz questions for a French 1 (beginner) course.

IMPORTANT CONTEXT: This quiz app uses a tiered evaluation system for typed answers:
- Exact match (normalized, accent-insensitive)
- Fuzzy matching (Levenshtein distance)
- AI-powered semantic evaluation (Claude Opus) for ambiguous or open-ended responses
Because of this, fill-in-blank and writing questions that accept multiple valid answers are FINE — the evaluation pipeline handles them. Do NOT flag a question as incoherent just because multiple answers could be correct.

## French Grammar Reference — DO NOT flag these as errors

These are all CORRECT French. Verify carefully before flagging grammar issues:

**Articles & Partitives**
- Definite articles for general preferences: "J'aime les pommes" (NOT "J'aime des pommes") — French uses le/la/les when expressing likes/dislikes about general categories
- Partitive after negation becomes "de": "Je ne mange pas de pommes" (NOT "pas des pommes"). "ne...pas de" replaces du/de la/des
- Mandatory contractions: à+le→au, à+les→aux, de+le→du, de+les→des
- No article after "en" for countries/continents: "en France" (NOT "en la France")

**Conjugation & Pronouns**
- "On" ALWAYS takes 3rd person singular: "on aime", "on mange", "on fait" — even when meaning "we"
- Stressed/disjunctive pronouns after prepositions: "avec moi" (NOT "avec je"), "pour toi", "chez lui"
- Conjugation-only answers (without subject pronouns) are standard in fill-in-blank exercises: "mangeons" is a valid answer for "nous _____"

**Elision & Liaison**
- Elision occurs ONLY before vowel sounds and mute h: j'aime, l'école, l'homme, n'aime, d'accord
- Elision does NOT occur before consonants: "la liberté" is correct (NOT "l'liberté"), "le livre" is correct
- "Le haricot" is correct (aspirated h, no elision)

**Expressions with avoir/faire**
- Use "avoir" for physical states: avoir faim, avoir soif, avoir chaud, avoir froid, avoir sommeil (NOT "être faim")
- Use "faire" + partitive for activities: faire du sport, faire de la natation, faire du vélo
- Use "boire" for beverages, not "manger": "boire du café" (NOT "manger du café")

**Miscellaneous**
- "Il y a" means both "there is" and "there are" — it is invariable
- Aller + infinitive for near future is valid French 1 grammar: "Je vais manger"
- No capitalization required after "et" in coordinate structures: "les blogs et les films" is correct
- Days of the week are NOT capitalized in French: "lundi", "mardi" (NOT "Lundi")

## Evaluation Criteria

For each question, evaluate these 4 criteria:

1. **answer_correct**: Is the provided correct answer actually correct? Would a French teacher accept it?
2. **grammar_correct**: Is the French in both the question AND answer grammatically correct? Check against the grammar reference above before flagging.
3. **no_hallucination**: Is everything factually accurate? No made-up vocabulary, fabricated grammar rules, incorrect cultural facts, or nonexistent French words?
4. **question_coherent**: Is the question genuinely nonsensical or unanswerable? Only flag FALSE if a student could not reasonably understand what is being asked, or if the question is self-contradictory. Do NOT flag questions as incoherent for having multiple valid answers — the grading system handles that. For multiple-choice questions, evaluate coherence based on the provided options.

Respond in this exact JSON format (no markdown, no code fences):
{"answer_correct": true/false, "grammar_correct": true/false, "no_hallucination": true/false, "question_coherent": true/false, "notes": "brief explanation of any issues found, or 'OK' if all pass"}`;

const PAGE_SIZE = 1000;

async function fetchQuestions(options: CLIOptions): Promise<QuestionRow[]> {
  let all: QuestionRow[] = [];
  let page = 0;
  while (true) {
    let query = supabase
      .from('questions')
      .select('id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, generated_by, options');
    if (options.unitId) query = query.eq('unit_id', options.unitId);
    if (options.difficulty) query = query.eq('difficulty', options.difficulty);
    if (options.type) query = query.eq('type', options.type);
    if (options.model) query = query.eq('generated_by', options.model);
    if (options.batchId) query = query.eq('batch_id', options.batchId);
    if (options.pendingOnly) query = query.eq('quality_status', 'pending');
    query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    const { data, error } = await query;
    if (error) throw new Error(`Fetch error: ${error.message}`);
    if (!data || data.length === 0) break;
    all = all.concat(data as QuestionRow[]);
    page++;
  }

  // Random sample if --limit specified
  if (options.limit && options.limit < all.length) {
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    all = all.slice(0, options.limit);
  }

  return all;
}

async function auditQuestion(q: QuestionRow): Promise<AuditResult> {
  const optionsLine = q.type === 'multiple-choice' && q.options
    ? `\nOptions: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(' | ')}`
    : '';

  const prompt = `${AUDIT_PROMPT}

Question type: ${q.type}${q.writing_type ? ` (${q.writing_type})` : ''}
Topic: ${q.topic}
Difficulty: ${q.difficulty}

Question: ${q.question}${optionsLine}
Correct answer: ${q.correct_answer}`;

  const response = await anthropic.messages.create({
    model: EVALUATOR_MODEL,
    max_tokens: 500,
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
      generated_by: q.generated_by,
      question: q.question,
      answer: q.correct_answer,
      answer_correct: parsed.answer_correct,
      grammar_correct: parsed.grammar_correct,
      no_hallucination: parsed.no_hallucination,
      question_coherent: parsed.question_coherent,
      notes: parsed.notes || '',
    };
  } catch {
    // Parse errors are tool failures, not question quality failures.
    // Mark all criteria as passing to avoid inflating flag counts.
    // The error is still logged in notes for investigation.
    return {
      id: q.id,
      topic: q.topic,
      type: q.type,
      writing_type: q.writing_type,
      generated_by: q.generated_by,
      question: q.question,
      answer: q.correct_answer,
      answer_correct: true,
      grammar_correct: true,
      no_hallucination: true,
      question_coherent: true,
      notes: `PARSE_ERROR: ${text.substring(0, 200)}`,
    };
  }
}

async function main() {
  const options = parseArgs();

  const filters = [
    options.unitId && `unit=${options.unitId}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
    options.model && `model=${options.model}`,
    options.limit && `limit=${options.limit}`,
    options.pendingOnly && 'pending-only',
  ].filter(Boolean);

  console.log(`Fetching questions${filters.length ? ` (${filters.join(', ')})` : ''}...`);
  const questions = await fetchQuestions(options);
  console.log(`Found ${questions.length} questions to audit.\n`);

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
  const parseErrors = results.filter(r => r.notes.startsWith('PARSE_ERROR:'));

  console.log('═'.repeat(60));
  console.log('QUALITY AUDIT COMPLETE');
  console.log('═'.repeat(60));
  console.log(`  Total evaluated: ${results.length}`);
  console.log(`  All pass:        ${results.length - flagged.length} (${((results.length - flagged.length) / results.length * 100).toFixed(1)}%)`);
  console.log(`  Flagged:         ${flagged.length} (${(flagged.length / results.length * 100).toFixed(1)}%)`);
  if (parseErrors.length > 0) {
    console.log(`  Parse errors:    ${parseErrors.length} (not counted as flags)`);
  }
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

      console.log(`\n  [${flags.join(', ')}] ${f.id} | ${f.type}${f.writing_type ? '/' + f.writing_type : ''} | ${f.topic}`);
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

  // By model breakdown
  const models = [...new Set(results.map(r => r.generated_by || 'unknown'))];
  if (models.length > 1 || (models.length === 1 && models[0] !== 'unknown')) {
    console.log('\n' + '─'.repeat(60));
    console.log('PASS RATE BY MODEL');
    console.log('─'.repeat(60));
    for (const m of models) {
      const modelResults = results.filter(r => (r.generated_by || 'unknown') === m);
      const modelPass = modelResults.filter(r =>
        r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent
      ).length;
      console.log(`  ${m}: ${modelPass}/${modelResults.length} pass (${(modelPass / modelResults.length * 100).toFixed(1)}%)`);
    }

    // Per-model failure breakdown
    console.log('\n' + '─'.repeat(60));
    console.log('FAILURES BY MODEL + CRITERION');
    console.log('─'.repeat(60));
    for (const m of models) {
      const mr = results.filter(r => (r.generated_by || 'unknown') === m);
      const ac = mr.filter(r => !r.answer_correct).length;
      const gc = mr.filter(r => !r.grammar_correct).length;
      const hf = mr.filter(r => !r.no_hallucination).length;
      const cf = mr.filter(r => !r.question_coherent).length;
      console.log(`  ${m} (n=${mr.length}):`);
      console.log(`    Answer incorrect:  ${ac} (${(ac / mr.length * 100).toFixed(1)}%)`);
      console.log(`    Grammar incorrect: ${gc} (${(gc / mr.length * 100).toFixed(1)}%)`);
      console.log(`    Hallucination:     ${hf} (${(hf / mr.length * 100).toFixed(1)}%)`);
      console.log(`    Incoherent:        ${cf} (${(cf / mr.length * 100).toFixed(1)}%)`);
    }
  }

  // Write quality_status to database if --write-db is set
  if (options.markDb) {
    console.log('\n' + '═'.repeat(60));
    console.log('WRITING QUALITY STATUS TO DATABASE');
    console.log('═'.repeat(60));

    const flaggedIds = flagged.map(r => r.id);
    const passingIds = results.filter(r =>
      r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent
      && !r.notes.startsWith('PARSE_ERROR:')
    ).map(r => r.id);

    // Mark flagged questions
    if (flaggedIds.length > 0) {
      const { error: flagError } = await supabase
        .from('questions')
        .update({ quality_status: 'flagged' })
        .in('id', flaggedIds);

      if (flagError) {
        console.error(`  Error marking flagged questions: ${flagError.message}`);
      } else {
        console.log(`  Marked ${flaggedIds.length} questions as 'flagged'`);
      }
    }

    // Mark passing questions as active (promotes pending → active)
    if (passingIds.length > 0) {
      const { error: activeError } = await supabase
        .from('questions')
        .update({ quality_status: 'active' })
        .in('id', passingIds);

      if (activeError) {
        console.error(`  Error marking active questions: ${activeError.message}`);
      } else {
        console.log(`  Marked ${passingIds.length} questions as 'active'`);
      }
    }

    // Parse errors are left unchanged (not enough info to judge)
    if (parseErrors.length > 0) {
      console.log(`  Skipped ${parseErrors.length} questions with parse errors (status unchanged)`);
    }

    // Promotion summary when auditing pending questions
    if (options.pendingOnly) {
      console.log('\n  Promotion summary (pending questions):');
      console.log(`    Promoted to active:  ${passingIds.length}`);
      console.log(`    Flagged:             ${flaggedIds.length}`);
      if (parseErrors.length > 0) {
        console.log(`    Still pending:       ${parseErrors.length} (parse errors)`);
      }
    }
  }
}

main().catch(console.error);
