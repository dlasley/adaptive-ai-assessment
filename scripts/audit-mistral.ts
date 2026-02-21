/**
 * Stage 3: Audit & Remediation using Mistral Large.
 * Independent French-native evaluation to catch errors Anthropic models may miss.
 * Applies safe remediations: difficulty relabeling + invalid variation removal.
 *
 * Requires: MISTRAL_API_KEY in .env.local
 *   Get API key: https://console.mistral.ai/api-keys
 *   Pricing: Mistral Large = $2/M input, $6/M output
 *   Estimated cost for full corpus (~1,039 questions): ~$1-2
 *
 * Usage:
 *   npx tsx scripts/audit-quality-mistral.ts                        # Audit all questions
 *   npx tsx scripts/audit-quality-mistral.ts --unit unit-2          # Filter by unit
 *   npx tsx scripts/audit-quality-mistral.ts --difficulty advanced   # Filter by difficulty
 *   npx tsx scripts/audit-quality-mistral.ts --type writing         # Filter by question type
 *   npx tsx scripts/audit-quality-mistral.ts --limit 50             # Random sample of N
 *   npx tsx scripts/audit-quality-mistral.ts --batch batch_xyz      # Filter by batch_id
 *   npx tsx scripts/audit-quality-mistral.ts --pending-only         # Audit only pending questions
 *   npx tsx scripts/audit-quality-mistral.ts --export data/out.json # Export results to JSON
 *   npx tsx scripts/audit-quality-mistral.ts --write-db              # Write quality_status + audit_metadata to DB
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { Mistral } from '@mistralai/mistralai';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { checkGitState } from './lib/git-utils';
import { createScriptSupabase, PAGE_SIZE } from './lib/db-queries';

// Validate Mistral API key
if (!process.env.MISTRAL_API_KEY) {
  console.error('Error: MISTRAL_API_KEY not found in .env.local');
  console.error('Get an API key at https://console.mistral.ai/api-keys');
  process.exit(1);
}

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// Supabase client — initialized in main() after parseArgs()
let supabase!: ReturnType<typeof createScriptSupabase>;

const MISTRAL_MODEL = 'mistral-large-latest';
const BATCH_SIZE = 5;
const RATE_LIMIT_DELAY_MS = 1000; // Base delay between batches (Scale tier: 6 req/s, 2M tokens/min)
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000; // Exponential backoff: 2s, 4s, 8s

// Load the evaluation prompt from markdown file
const SYSTEM_PROMPT = readFileSync(
  resolve(__dirname, 'prompts/audit-mistral.md'),
  'utf-8',
);

interface CLIOptions {
  unitId?: string;
  difficulty?: string;
  type?: string;
  limit?: number;
  batchId?: string;
  writeDb?: boolean;
  pendingOnly?: boolean;
  exportPath?: string;
  // Experiment framework
  experimentId?: string;
  cohort?: string;
  auditModel?: string;
}


function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--unit': options.unitId = args[++i]; break;
      case '--difficulty': options.difficulty = args[++i]; break;
      case '--type': options.type = args[++i]; break;
      case '--limit': options.limit = parseInt(args[++i], 10); break;
      case '--batch': options.batchId = args[++i]; break;
      case '--write-db': options.writeDb = true; break;
      case '--pending-only': options.pendingOnly = true; break;
      case '--export': options.exportPath = args[++i]; break;
      case '--experiment-id': options.experimentId = args[++i]; break;
      case '--cohort': options.cohort = args[++i]; break;
      case '--audit-model': options.auditModel = args[++i]; break;
    }
  }

  if (options.experimentId && !options.cohort) {
    console.error('Error: --experiment-id requires --cohort');
    process.exit(1);
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
  acceptable_variations: string[] | null;
}

export interface MistralAuditResult {
  id: string;
  topic: string;
  type: string;
  writing_type: string | null;
  generated_by: string | null;
  question: string;
  answer: string;
  // Core 4 (shared with Sonnet audit)
  answer_correct: boolean;
  grammar_correct: boolean;
  no_hallucination: boolean;
  question_coherent: boolean;
  // Mistral-specific
  natural_french: boolean;
  register_appropriate: boolean;
  difficulty_appropriate: boolean;
  suggested_difficulty: string | null;
  variations_valid: boolean;
  culturally_appropriate: boolean;
  missing_variations: string[];
  invalid_variations: string[];
  notes: string;
  severity: 'critical' | 'minor' | 'suggestion';
}


async function fetchQuestions(options: CLIOptions, tableName: string): Promise<QuestionRow[]> {
  let all: QuestionRow[] = [];
  let page = 0;
  while (true) {
    let query = supabase
      .from(tableName)
      .select('id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, generated_by, options, acceptable_variations');
    if (options.experimentId && tableName === 'experiment_questions') {
      query = query.eq('experiment_id', options.experimentId).eq('cohort', options.cohort!);
    }
    if (options.unitId) query = query.eq('unit_id', options.unitId);
    if (options.difficulty) query = query.eq('difficulty', options.difficulty);
    if (options.type) query = query.eq('type', options.type);
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

function formatQuestionForPrompt(q: QuestionRow): string {
  const lines: string[] = [];
  lines.push(`ID: ${q.id}`);
  lines.push(`Question type: ${q.type}${q.writing_type ? ` (${q.writing_type})` : ''}`);
  lines.push(`Topic: ${q.topic}`);
  lines.push(`Difficulty: ${q.difficulty}`);
  lines.push(`Question: ${q.question}`);

  if (q.type === 'multiple-choice' && q.options) {
    lines.push(`Options: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(' | ')}`);
  }

  lines.push(`Correct answer: ${q.correct_answer}`);

  if (q.acceptable_variations && q.acceptable_variations.length > 0) {
    lines.push(`Acceptable variations: ${q.acceptable_variations.join(', ')}`);
  }

  return lines.join('\n');
}

async function auditBatch(questions: QuestionRow[]): Promise<MistralAuditResult[]> {
  const questionsText = questions
    .map((q, i) => `--- Question ${i + 1} ---\n${formatQuestionForPrompt(q)}`)
    .join('\n\n');

  const userPrompt = `Evaluate the following ${questions.length} question(s). Return a JSON array with one result object per question, in the same order.\n\n${questionsText}`;

  const response = await mistral.chat.complete({
    model: MISTRAL_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  const content = response.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error('Empty response from Mistral');
  }

  try {
    const parsed = JSON.parse(content);
    // Handle both array and { results: [...] } formats
    const results: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : (parsed.results || parsed.questions || [parsed]);

    return questions.map((q, i) => {
      const r = results[i] || {};
      return {
        id: q.id,
        topic: q.topic,
        type: q.type,
        writing_type: q.writing_type,
        generated_by: q.generated_by,
        question: q.question,
        answer: q.correct_answer,
        answer_correct: r.answer_correct !== false,
        grammar_correct: r.grammar_correct !== false,
        no_hallucination: r.no_hallucination !== false,
        question_coherent: r.question_coherent !== false,
        natural_french: r.natural_french !== false,
        register_appropriate: r.register_appropriate !== false,
        difficulty_appropriate: r.difficulty_appropriate !== false,
        suggested_difficulty: (typeof r.suggested_difficulty === 'string' ? r.suggested_difficulty : null),
        variations_valid: r.variations_valid !== false,
        culturally_appropriate: r.culturally_appropriate !== false,
        missing_variations: Array.isArray(r.missing_variations) ? r.missing_variations as string[] : [],
        invalid_variations: Array.isArray(r.invalid_variations) ? r.invalid_variations as string[] : [],
        notes: (r.notes as string) || 'OK',
        severity: (['critical', 'minor', 'suggestion'].includes(r.severity as string) ? r.severity : 'suggestion') as 'critical' | 'minor' | 'suggestion',
      };
    });
  } catch {
    // Parse failure — mark all as passing with error note
    console.error(`\n  Parse error for batch. Raw response: ${content.substring(0, 300)}`);
    return questions.map(q => ({
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
      natural_french: true,
      register_appropriate: true,
      difficulty_appropriate: true,
      suggested_difficulty: null,
      variations_valid: true,
      culturally_appropriate: true,
      missing_variations: [],
      invalid_variations: [],
      notes: `PARSE_ERROR: ${content.substring(0, 200)}`,
      severity: 'suggestion' as const,
    }));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs();

  // Initialize Supabase (write mode if --write-db)
  supabase = createScriptSupabase({ write: options.writeDb });

  // Git safety check
  checkGitState({
    experimentId: options.experimentId,
  });

  // Determine table target based on experiment mode
  const tableName = options.experimentId ? 'experiment_questions' : 'questions';

  const filters = [
    options.unitId && `unit=${options.unitId}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
    options.limit && `limit=${options.limit}`,
    options.batchId && `batch=${options.batchId}`,
    options.pendingOnly && 'pending-only',
    options.experimentId && `experiment=${options.experimentId}`,
    options.cohort && `cohort=${options.cohort}`,
  ].filter(Boolean);

  console.log(`Fetching questions${filters.length ? ` (${filters.join(', ')})` : ''}...`);
  const questions = await fetchQuestions(options, tableName);
  console.log(`Found ${questions.length} questions to audit with Mistral Large.\n`);

  if (questions.length === 0) {
    console.log('No questions found. Exiting.');
    return;
  }

  const results: MistralAuditResult[] = [];
  let currentDelay = RATE_LIMIT_DELAY_MS;

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const batchResults = await auditBatch(batch);
        results.push(...batchResults);
        break;
      } catch (err) {
        const errStr = String(err);
        const is429 = errStr.includes('429') || errStr.toLowerCase().includes('rate limit');

        if (is429 && attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          currentDelay = Math.min(currentDelay * 2, 10_000);
          console.warn(`\n  ⚠️  Rate limited (429) at batch ${i}. Retry ${attempt + 1}/${MAX_RETRIES} in ${backoff / 1000}s... (base delay now ${currentDelay}ms)`);
          await sleep(backoff);
          continue;
        }

        // Non-retryable error or max retries exhausted
        if (is429) {
          console.error(`\n  ❌ Rate limit persists after ${MAX_RETRIES} retries at batch ${i}`);
        } else {
          console.error(`\n  Batch error at ${i}: ${err}`);
        }

        for (const q of batch) {
          results.push({
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
            natural_french: true,
            register_appropriate: true,
            difficulty_appropriate: true,
            suggested_difficulty: null,
            variations_valid: true,
            culturally_appropriate: true,
            missing_variations: [],
            invalid_variations: [],
            notes: `API_ERROR: ${String(err).substring(0, 200)}`,
            severity: 'suggestion',
          });
        }
      }
    }

    const pct = Math.round(((i + batch.length) / questions.length) * 100);
    process.stdout.write(`\r  Progress: ${i + batch.length}/${questions.length} (${pct}%)`);

    // Rate limiting between batches (adaptive — increases after 429s)
    if (i + BATCH_SIZE < questions.length) {
      await sleep(currentDelay);
    }
  }

  console.log('\n');

  // Export results to JSON if requested
  if (options.exportPath) {
    writeFileSync(options.exportPath, JSON.stringify(results, null, 2));
    console.log(`Results exported to ${options.exportPath}\n`);
  }

  // ── Summary ──────────────────────────────────────────────
  // 6-gate: the criteria that actually determine flagged vs active
  const isGatePass = (r: MistralAuditResult) =>
    r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent &&
    r.natural_french && r.register_appropriate;

  const parseErrors = results.filter(r => r.notes.startsWith('PARSE_ERROR:') || r.notes.startsWith('API_ERROR:'));
  const evaluated = results.filter(r => !r.notes.startsWith('PARSE_ERROR:') && !r.notes.startsWith('API_ERROR:'));
  const evalCount = evaluated.length;
  const gatePass = evaluated.filter(r => isGatePass(r));
  const gateFlagged = evaluated.filter(r => !isGatePass(r));
  const all9Flagged = evaluated.filter(r =>
    !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent ||
    !r.natural_french || !r.register_appropriate || !r.difficulty_appropriate || !r.variations_valid ||
    !r.culturally_appropriate
  );
  const critical = evaluated.filter(r => r.severity === 'critical');
  const minor = evaluated.filter(r => r.severity === 'minor');

  console.log('='.repeat(60));
  console.log('MISTRAL AUDIT & REMEDIATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Model:             ${MISTRAL_MODEL}`);
  console.log(`  Total attempted:   ${results.length}`);
  if (parseErrors.length > 0) {
    console.log(`  Parse/API errors:  ${parseErrors.length} (skipped — status unchanged)`);
  }
  console.log(`  Actually evaluated:${evalCount}`);
  if (evalCount > 0) {
    console.log(`  6-gate pass:       ${gatePass.length}/${evalCount} (${(gatePass.length / evalCount * 100).toFixed(1)}%) → would be activated`);
    console.log(`  6-gate flagged:    ${gateFlagged.length}/${evalCount} (${(gateFlagged.length / evalCount * 100).toFixed(1)}%) → would be flagged`);
    console.log(`  All 9 clean:       ${evalCount - all9Flagged.length}/${evalCount} (${((evalCount - all9Flagged.length) / evalCount * 100).toFixed(1)}%) (no issues at all)`);
  }
  console.log();

  // Breakdown by criterion — gate vs soft signals
  const gateCriteria = [
    { key: 'answer_correct', label: 'Answer incorrect' },
    { key: 'grammar_correct', label: 'Grammar incorrect' },
    { key: 'no_hallucination', label: 'Hallucination' },
    { key: 'question_coherent', label: 'Incoherent' },
    { key: 'natural_french', label: 'Unnatural French' },
    { key: 'register_appropriate', label: 'Register mismatch' },
  ] as const;
  const softCriteria = [
    { key: 'difficulty_appropriate', label: 'Difficulty mismatch' },
    { key: 'variations_valid', label: 'Invalid variations' },
    { key: 'culturally_appropriate', label: 'Cultural sensitivity' },
  ] as const;

  console.log('Gate criteria (all must pass for active):');
  for (const c of gateCriteria) {
    const count = evaluated.filter(r => !(r[c.key as keyof MistralAuditResult])).length;
    console.log(`  ${c.label.padEnd(22)} ${count}${evalCount > 0 ? ` (${(count / evalCount * 100).toFixed(1)}%)` : ''}`);
  }
  console.log('\nSoft signals (remediated, not gated):');
  for (const c of softCriteria) {
    const count = evaluated.filter(r => !(r[c.key as keyof MistralAuditResult])).length;
    console.log(`  ${c.label.padEnd(22)} ${count}${evalCount > 0 ? ` (${(count / evalCount * 100).toFixed(1)}%)` : ''}`);
  }

  // Severity breakdown
  console.log(`\nSeverity distribution:`);
  console.log(`  Critical:   ${critical.length}`);
  console.log(`  Minor:      ${minor.length}`);
  console.log(`  Suggestion: ${evaluated.filter(r => r.severity === 'suggestion').length}`);

  // Variations analysis
  const withVariations = evaluated.filter(r =>
    r.type === 'fill-in-blank' || r.type === 'writing'
  );
  const totalMissing = evaluated.reduce((sum, r) => sum + r.missing_variations.length, 0);
  const totalInvalid = evaluated.reduce((sum, r) => sum + r.invalid_variations.length, 0);
  if (withVariations.length > 0) {
    console.log(`\nVariation analysis (${withVariations.length} typed-answer questions):`);
    console.log(`  Missing variations suggested: ${totalMissing}`);
    console.log(`  Invalid variations flagged:   ${totalInvalid}`);
  }

  // Difficulty reclassification analysis
  const questionMap = new Map(questions.map(q => [q.id, q]));
  const diffMismatches = results.filter(r => !r.difficulty_appropriate);
  if (diffMismatches.length > 0) {
    console.log(`\nDifficulty reclassification (${diffMismatches.length} mismatches):`);
    // Build reclassification matrix
    const reclass: Record<string, Record<string, number>> = {};
    for (const r of diffMismatches) {
      const current = questionMap.get(r.id)?.difficulty || 'unknown';
      const suggested = r.suggested_difficulty || 'unknown';
      if (!reclass[current]) reclass[current] = {};
      reclass[current][suggested] = (reclass[current][suggested] || 0) + 1;
    }
    for (const [from, tos] of Object.entries(reclass)) {
      for (const [to, count] of Object.entries(tos)) {
        console.log(`  ${from} -> ${to}: ${count}`);
      }
    }
  }

  // Show flagged questions — gate failures first, then soft-signal-only
  const printQuestion = (f: MistralAuditResult) => {
    const flags: string[] = [];
    if (!f.answer_correct) flags.push('ANSWER');
    if (!f.grammar_correct) flags.push('GRAMMAR');
    if (!f.no_hallucination) flags.push('HALLUCINATION');
    if (!f.question_coherent) flags.push('INCOHERENT');
    if (!f.natural_french) flags.push('UNNATURAL');
    if (!f.register_appropriate) flags.push('REGISTER');
    if (!f.difficulty_appropriate) flags.push(`DIFFICULTY(${f.suggested_difficulty || '?'})`);
    if (!f.variations_valid) flags.push('VARIATIONS');
    if (!f.culturally_appropriate) flags.push('CULTURAL');

    console.log(`\n  [${f.severity.toUpperCase()}] [${flags.join(', ')}] ${f.id}`);
    console.log(`  ${f.type}${f.writing_type ? '/' + f.writing_type : ''} | ${f.topic} | ${f.generated_by || 'unknown'}`);
    console.log(`  Q: ${f.question}`);
    console.log(`  A: ${f.answer}`);
    if (f.missing_variations.length > 0) {
      console.log(`  Missing: ${f.missing_variations.join(', ')}`);
    }
    if (f.invalid_variations.length > 0) {
      console.log(`  Invalid: ${f.invalid_variations.join(', ')}`);
    }
    console.log(`  Notes: ${f.notes}`);
  };

  const severityOrder = { critical: 0, minor: 1, suggestion: 2 };
  const gateFailures = gateFlagged;
  const softOnly = all9Flagged.filter(r => isGatePass(r));

  if (gateFailures.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(`GATE FAILURES (${gateFailures.length} — would be flagged)`);
    console.log('-'.repeat(60));
    const sorted = [...gateFailures].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    for (const f of sorted) printQuestion(f);
  }

  if (softOnly.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(`SOFT-SIGNAL ISSUES (${softOnly.length} — pass gate, remediated)`);
    console.log('-'.repeat(60));
    const sorted = [...softOnly].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    for (const f of sorted) printQuestion(f);
  }

  // Pass rate by type (6-gate, evaluated only)
  console.log('\n' + '-'.repeat(60));
  console.log('6-GATE PASS RATE BY TYPE');
  console.log('-'.repeat(60));
  const types = [...new Set(evaluated.map(r => r.type))];
  for (const t of types) {
    const typeResults = evaluated.filter(r => r.type === t);
    const typePass = typeResults.filter(r => isGatePass(r)).length;
    console.log(`  ${t}: ${typePass}/${typeResults.length} pass (${(typePass / typeResults.length * 100).toFixed(1)}%)`);
  }

  // Pass rate by difficulty (6-gate, evaluated only)
  console.log('\n' + '-'.repeat(60));
  console.log('6-GATE PASS RATE BY DIFFICULTY');
  console.log('-'.repeat(60));
  for (const d of ['beginner', 'intermediate', 'advanced']) {
    const dResults = evaluated.filter(r => questionMap.get(r.id)?.difficulty === d);
    if (dResults.length === 0) continue;
    const dPass = dResults.filter(r => isGatePass(r)).length;
    console.log(`  ${d}: ${dPass}/${dResults.length} pass (${(dPass / dResults.length * 100).toFixed(1)}%)`);
  }

  // Post-relabeling difficulty distribution (6-gate passing only)
  const passingWithDiff = gatePass.map(r => {
    const current = questionMap.get(r.id)?.difficulty || 'unknown';
    const suggested = r.suggested_difficulty;
    const final = (suggested && ['beginner', 'intermediate', 'advanced'].includes(suggested) && suggested !== current)
      ? suggested : current;
    return final;
  });
  const diffDist: Record<string, number> = {};
  for (const d of passingWithDiff) diffDist[d] = (diffDist[d] || 0) + 1;
  console.log('\n' + '-'.repeat(60));
  console.log(`SERVED DIFFICULTY DISTRIBUTION (${gatePass.length} active, post-relabeling)`);
  console.log('-'.repeat(60));
  for (const d of ['beginner', 'intermediate', 'advanced']) {
    const count = diffDist[d] || 0;
    console.log(`  ${d}: ${count} (${(count / gatePass.length * 100).toFixed(1)}%)`);
  }

  // Write quality_status + audit_metadata to database if --write-db is set
  if (options.writeDb) {
    console.log('\n' + '='.repeat(60));
    console.log('WRITING QUALITY STATUS + AUDIT METADATA TO DATABASE');
    console.log('='.repeat(60));

    const isError = (r: MistralAuditResult) =>
      r.notes.startsWith('PARSE_ERROR:') || r.notes.startsWith('API_ERROR:');

    // Build audit_metadata JSONB for each result
    const buildAuditMetadata = (r: MistralAuditResult) => ({
      auditor: 'mistral',
      model: MISTRAL_MODEL,
      audited_at: new Date().toISOString(),
      gate_criteria: {
        answer_correct: r.answer_correct,
        grammar_correct: r.grammar_correct,
        no_hallucination: r.no_hallucination,
        question_coherent: r.question_coherent,
        natural_french: r.natural_french,
        register_appropriate: r.register_appropriate,
      },
      soft_signals: {
        difficulty_appropriate: r.difficulty_appropriate,
        suggested_difficulty: r.suggested_difficulty,
        variations_valid: r.variations_valid,
        missing_variations: r.missing_variations,
        invalid_variations: r.invalid_variations,
        culturally_appropriate: r.culturally_appropriate,
      },
      severity: r.severity,
      notes: r.notes,
    });

    const validResults = results.filter(r => !isError(r));
    const flaggedResults = validResults.filter(r => !isGatePass(r));
    const passingResults = validResults.filter(r => isGatePass(r));

    // Write flagged questions: quality_status + audit_metadata
    if (flaggedResults.length > 0) {
      // Supabase .in() doesn't support per-row data, so batch update individually
      let flaggedCount = 0;
      for (const r of flaggedResults) {
        const { error } = await supabase
          .from(tableName)
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

    // Write passing questions: quality_status + audit_metadata + remediation
    if (passingResults.length > 0) {
      let activeCount = 0;
      let difficultyRelabeled = 0;
      let variationsRemoved = 0;
      for (const r of passingResults) {
        const question = questionMap.get(r.id);
        const currentDifficulty = question?.difficulty;
        const suggestedDifficulty = r.suggested_difficulty;
        const shouldRelabel = suggestedDifficulty &&
          ['beginner', 'intermediate', 'advanced'].includes(suggestedDifficulty) &&
          suggestedDifficulty !== currentDifficulty;

        // Remediation: remove invalid variations (subtractive only, safe)
        const currentVariations = question?.acceptable_variations || [];
        const invalidVariations = r.invalid_variations || [];
        const shouldRemoveVariations = invalidVariations.length > 0 && currentVariations.length > 0;
        const cleanedVariations = shouldRemoveVariations
          ? currentVariations.filter(v => !invalidVariations.includes(v))
          : null; // null = no change needed

        const updateData: Record<string, unknown> = {
          quality_status: 'active',
          audit_metadata: buildAuditMetadata(r),
        };

        if (shouldRelabel) {
          updateData.difficulty = suggestedDifficulty;
        }

        if (cleanedVariations && cleanedVariations.length !== currentVariations.length) {
          updateData.acceptable_variations = cleanedVariations;
        }

        const { error } = await supabase
          .from(tableName)
          .update(updateData)
          .eq('id', r.id);

        if (error) {
          console.error(`  Error activating ${r.id}: ${error.message}`);
        } else {
          activeCount++;
          if (shouldRelabel) {
            difficultyRelabeled++;
            console.log(`    Difficulty re-label: ${r.id} ${currentDifficulty} -> ${suggestedDifficulty}`);
          }
          if (cleanedVariations && cleanedVariations.length !== currentVariations.length) {
            const removed = currentVariations.length - cleanedVariations.length;
            variationsRemoved += removed;
            console.log(`    Variations removed:  ${r.id} removed ${removed} invalid (${currentVariations.length} -> ${cleanedVariations.length})`);
          }
        }
      }
      console.log(`  Marked ${activeCount} questions as 'active' (with audit_metadata)`);
      if (difficultyRelabeled > 0) {
        console.log(`  Re-labeled difficulty on ${difficultyRelabeled} questions (Mistral suggested_difficulty)`);
      }
      if (variationsRemoved > 0) {
        console.log(`  Removed ${variationsRemoved} invalid variations across passing questions`);
      }
    }

    if (parseErrors.length > 0) {
      console.log(`  Skipped ${parseErrors.length} questions with errors (status unchanged)`);
    }

    // Promotion summary when auditing pending questions
    if (options.pendingOnly) {
      console.log('\n  Promotion summary (pending questions):');
      console.log(`    Promoted to active:  ${passingResults.length}`);
      console.log(`    Flagged:             ${flaggedResults.length}`);
      if (parseErrors.length > 0) {
        console.log(`    Still pending:       ${parseErrors.length} (parse/API errors)`);
      }
    }
  }
}

main().catch(console.error);
