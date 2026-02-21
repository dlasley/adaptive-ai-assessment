/**
 * Quality audit for quiz questions using Sonnet.
 * Uses the Sonnet audit prompt (scripts/prompts/audit-sonnet.md) to evaluate
 * 4 gate criteria: answer_correct, grammar_correct, no_hallucination, question_coherent.
 *
 * Sonnet does NOT apply remediation (no difficulty relabeling, no variation removal).
 * Use Mistral audit for 9-criteria evaluation with remediation.
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
 *   npx tsx scripts/audit-quality.ts --export data/audit-sonnet.json  # Export results to JSON
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createScriptSupabase, PAGE_SIZE } from './lib/db-queries';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EVALUATOR_MODEL = 'claude-sonnet-4-5-20250929';

// Load the Sonnet-specific evaluation prompt from markdown file
const AUDIT_PROMPT = readFileSync(
  resolve(__dirname, 'prompts/audit-sonnet.md'),
  'utf-8',
);

// Supabase client — initialized in main() after parseArgs()
let supabase!: ReturnType<typeof createScriptSupabase>;

interface CLIOptions {
  unitId?: string;
  difficulty?: string;
  type?: string;
  model?: string;
  limit?: number;
  batchId?: string;
  writeDb?: boolean;
  pendingOnly?: boolean;
  exportPath?: string;
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
      case '--write-db': options.writeDb = true; break;
      case '--pending-only': options.pendingOnly = true; break;
      case '--export': options.exportPath = args[++i]; break;
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

  // Initialize Supabase (write mode if --write-db)
  supabase = createScriptSupabase({ write: options.writeDb });

  const filters = [
    options.unitId && `unit=${options.unitId}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
    options.model && `model=${options.model}`,
    options.limit && `limit=${options.limit}`,
    options.batchId && `batch=${options.batchId}`,
    options.pendingOnly && 'pending-only',
  ].filter(Boolean);

  console.log(`Fetching questions${filters.length ? ` (${filters.join(', ')})` : ''}...`);
  const questions = await fetchQuestions(options);
  console.log(`Found ${questions.length} questions to audit with Sonnet.\n`);

  if (questions.length === 0) {
    console.log('No questions found. Exiting.');
    return;
  }

  const results: AuditResult[] = [];
  const BATCH = 5;

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

  // Export results to JSON if --export specified
  if (options.exportPath) {
    writeFileSync(options.exportPath, JSON.stringify(results, null, 2));
    console.log(`Results exported to ${options.exportPath}\n`);
  }

  // Summary
  const flagged = results.filter(r =>
    !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent
  );
  const parseErrors = results.filter(r => r.notes.startsWith('PARSE_ERROR:'));

  console.log('='.repeat(60));
  console.log('SONNET AUDIT COMPLETE (4-gate)');
  console.log('='.repeat(60));
  console.log(`  Model:           ${EVALUATOR_MODEL}`);
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
    console.log('\n' + '-'.repeat(60));
    console.log('FLAGGED QUESTIONS');
    console.log('-'.repeat(60));

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
  console.log('\n' + '-'.repeat(60));
  console.log('PASS RATE BY TYPE');
  console.log('-'.repeat(60));
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
    console.log('\n' + '-'.repeat(60));
    console.log('PASS RATE BY MODEL');
    console.log('-'.repeat(60));
    for (const m of models) {
      const modelResults = results.filter(r => (r.generated_by || 'unknown') === m);
      const modelPass = modelResults.filter(r =>
        r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent
      ).length;
      console.log(`  ${m}: ${modelPass}/${modelResults.length} pass (${(modelPass / modelResults.length * 100).toFixed(1)}%)`);
    }

    // Per-model failure breakdown
    console.log('\n' + '-'.repeat(60));
    console.log('FAILURES BY MODEL + CRITERION');
    console.log('-'.repeat(60));
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

  // Write quality_status + audit_metadata to database if --write-db is set
  if (options.writeDb) {
    console.log('\n' + '='.repeat(60));
    console.log('WRITING QUALITY STATUS + AUDIT METADATA TO DATABASE');
    console.log('='.repeat(60));

    // Build audit_metadata JSONB for each result (Sonnet: 4 criteria only)
    const buildAuditMetadata = (r: AuditResult) => ({
      auditor: 'sonnet',
      model: EVALUATOR_MODEL,
      audited_at: new Date().toISOString(),
      gate_criteria: {
        answer_correct: r.answer_correct,
        grammar_correct: r.grammar_correct,
        no_hallucination: r.no_hallucination,
        question_coherent: r.question_coherent,
      },
      notes: r.notes,
    });

    const validResults = results.filter(r => !r.notes.startsWith('PARSE_ERROR:'));
    const flaggedResults = validResults.filter(r =>
      !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent
    );
    const passingResults = validResults.filter(r =>
      r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent
    );

    // Write flagged questions: quality_status + audit_metadata
    if (flaggedResults.length > 0) {
      let flaggedCount = 0;
      for (const r of flaggedResults) {
        const { error } = await supabase
          .from('questions')
          .update({
            quality_status: 'flagged',
            audit_metadata: buildAuditMetadata(r),
          })
          .eq('id', r.id);
        if (error) {
          console.error(`  Error flagging ${r.id}: ${error.message}`);
        } else {
          flaggedCount++;
        }
      }
      console.log(`  Marked ${flaggedCount} questions as 'flagged' (with audit_metadata)`);
    }

    // Write passing questions: quality_status + audit_metadata (no remediation for Sonnet)
    if (passingResults.length > 0) {
      let activeCount = 0;
      for (const r of passingResults) {
        const { error } = await supabase
          .from('questions')
          .update({
            quality_status: 'active',
            audit_metadata: buildAuditMetadata(r),
          })
          .eq('id', r.id);
        if (error) {
          console.error(`  Error activating ${r.id}: ${error.message}`);
        } else {
          activeCount++;
        }
      }
      console.log(`  Marked ${activeCount} questions as 'active' (with audit_metadata)`);
    }

    // Parse errors are left unchanged (not enough info to judge)
    if (parseErrors.length > 0) {
      console.log(`  Skipped ${parseErrors.length} questions with parse errors (status unchanged)`);
    }

    // Promotion summary when auditing pending questions
    if (options.pendingOnly) {
      console.log('\n  Promotion summary (pending questions):');
      console.log(`    Promoted to active:  ${passingResults.length}`);
      console.log(`    Flagged:             ${flaggedResults.length}`);
      if (parseErrors.length > 0) {
        console.log(`    Still pending:       ${parseErrors.length} (parse errors)`);
      }
    }
  }
}

main().catch(console.error);
