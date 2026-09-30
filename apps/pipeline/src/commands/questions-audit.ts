/**
 * Stage 3: Audit & Remediation.
 *
 * Default auditor (Mistral Large): independent French-native evaluation against a 6-criteria
 * gate, with safe remediation on passing questions — difficulty relabeling and invalid variation
 * removal. Requires OPENROUTER_API_KEY in .env.local. Get an API key at
 * https://console.mistral.ai/api-keys. Pricing: Mistral Large = $2/M input, $6/M output.
 * Estimated cost for a full corpus (~1,039 questions): ~$1-2.
 *
 * --auditor sonnet: a narrower 4-criteria gate (answer_correct, grammar_correct,
 * no_hallucination, question_coherent), no remediation. Used as a cross-validation run against
 * the Mistral auditor, not as the primary gate. Sonnet has no batch mode.
 *
 * Both auditors write --write-db results one group at a time, as each group's audit call
 * completes, rather than accumulating the whole run in memory and writing once at the end — a
 * long run interrupted partway through (crash, Ctrl-C) keeps whatever it already wrote, and a
 * re-run with --pending-only picks up only what's left.
 */

import { loadEnv } from '../lib/env';
import crypto from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createScriptSupabase, fetchAllPages, type QuestionRow } from '../lib/db-queries';
import { fetchUnitsFromDb } from '../lib/units-db';
import { MODELS, AUDIT_GROUP_SIZE } from '../lib/pipeline-config';
import { DIFFICULTIES, isDifficulty } from '@adaptive/shared/enums';
import type { Unit } from '@adaptive/shared/types';
import { callLlm } from '@adaptive/shared/llm';
import { submitBatch, pollUntilDone } from '../lib/llm-batch';
import { renderCoursePrompt } from '@adaptive/shared/course';
import {
  loadUnitMaterials,
  findUnitHeadingMismatches,
  formatHeadingPreflightError,
  extractTopicContent,
  formatMaterialPreflightError,
  buildAuditMaterialsBlock,
  type UnresolvedTopicRef,
} from '../lib/learning-materials';
import {
  applyAuditResultsForGroup,
  applyAuditResults,
  auditGroupWithRetry,
  buildFallbackSessionId,
  callMistralAuditGroup,
  chunk,
  createSupabaseBatchJobStore,
  EMPTY_AUDIT_RESULTS_SUMMARY,
  fetchQuestionsByIds,
  mergeAuditResultsSummaries,
  renderedMistralAuditSystemPrompt,
  resumeAuditJob,
  submitAuditJob,
  summarizeAuditResultsWrite,
  sumResultUsage,
  ApplyAuditResultsSummary,
  MistralAuditResult,
  type QuestionRow as AuditQuestionRow,
} from '../lib/mistral-audit';
import {
  applySonnetAuditResultsForGroup,
  ApplySonnetAuditResultsSummary,
  EMPTY_SONNET_AUDIT_RESULTS_SUMMARY,
  mergeSonnetAuditResultsSummaries,
  summarizeSonnetAuditResultsWrite,
  SonnetAuditResult,
} from '../lib/sonnet-audit';
import { runStreamingAudit } from '../lib/streaming-audit';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, questionFilterFlags, loggingFlags } from '../lib/options/groups';
import { createLogger, levelFromFlags, setLogLevel } from '../lib/logger';
import { PROMPTS_DIR } from '../lib/paths';
import { runIfMain } from '../lib/run-if-main';
import { installSigintFlag } from '../lib/sigint';
import { ensureDirFor } from '../lib/fs-utils';
import { emptyUsageTotals, formatUsageSummary, recordCall, type UsageTotals } from '../lib/usage-tracking';
import { BASE_INTER_GROUP_DELAY_MS, nextInterGroupDelay } from '../lib/rate-limit-delay';

const logger = createLogger('questions-audit');

// Supabase client — initialized in main() after parseArgs()
let supabase!: ReturnType<typeof createScriptSupabase>;

// OpenRouter's pinned Mistral pool returns 429 in bursts that outlast a short backoff.
const MAX_RETRIES = 6;
const INITIAL_BACKOFF_MS = 5000; // Exponential backoff: 5s, 10s, 20s, 40s, then capped
const MAX_BACKOFF_MS = 60_000;

// Raw template, not yet {{COURSE_NAME}}-rendered — a plain file read, safe at module scope. The
// render step happens at each use site via renderCoursePrompt(), which only runs once main() is
// actually invoked (never merely from importing this module), by which point loadEnv() has run.
// The Mistral audit's own system prompt is loaded and rendered by mistral-audit.ts instead, since
// callMistralAuditGroup() needs it too.
const RAW_SONNET_PROMPT = readFileSync(join(PROMPTS_DIR, 'audit-sonnet.md'), 'utf-8');

/** sha256 (16 hex) of a rendered prompt — stored in audit_metadata.prompt_hash for provenance. */
function hashPrompt(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 16);
}

export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...questionFilterFlags,
    ...loggingFlags,
    auditor: {
      type: 'string',
      choices: ['mistral', 'sonnet'] as const,
      default: 'mistral',
      help: "Auditor to use: 'mistral' (6-criteria gate + remediation, default) or 'sonnet' (4-criteria gate, no remediation)",
    },
    model: { type: 'string', help: 'Filter by generator model (sonnet only)' },
    limit: { type: 'number', min: 1, help: 'Random sample of N questions' },
    'pending-only': { type: 'boolean', default: false, help: 'Audit only pending questions' },
    'allow-missing-material': {
      type: 'boolean',
      default: false,
      help: 'Skip the material-resolution preflight and audit anyway when a topic resolves to no reference material',
    },
    output: { type: 'string', help: 'Export results to JSON' },
    'llm-batch': {
      type: 'boolean',
      default: false,
      help: 'Submit as an OpenRouter batch instead of auditing synchronously (mistral only)',
      group: 'Batch mode',
    },
    'llm-batch-resume': {
      type: 'string',
      help: 'Poll a submitted batch job; combine with --write-db to apply results once complete (mistral only)',
      group: 'Batch mode',
    },
  },
  {
    name: 'questions-audit',
    description: "Audit questions for quality (default: Mistral's 6-criteria gate with remediation; --auditor sonnet for a narrower 4-criteria gate, no remediation).",
    examples: [
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --unit unit-2 --write-db',
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --pending-only --write-db',
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --auditor sonnet --unit unit-2 --write-db',
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --output content/exports/audit-results.json',
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --unit unit-2 --pending-only --llm-batch',
      'npx tsx apps/pipeline/src/commands/questions-audit.ts --llm-batch-resume <job-id> --write-db',
    ],
    validate: (o) => {
      if (o.auditor === 'sonnet' && (o.llmBatch || o.llmBatchResume)) {
        return 'Error: --llm-batch/--llm-batch-resume require --auditor mistral (Sonnet audits synchronously only)';
      }
      if (o.model && o.auditor !== 'sonnet') return 'Error: --model requires --auditor sonnet';
    },
  },
);

type Options = ReturnType<typeof cli.parse>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two-gate preflight, run before any model call: fails loudly rather than letting
 * `buildAuditMaterialsBlock` silently hand the auditor a "(no source material found for this
 * topic)" placeholder.
 *
 * Gate 1 validates every topic's stored headings, for every unit referenced by `questions`,
 * against that unit's current markdown — the same preflight `questions-generate.ts` runs before
 * generation. This only inspects topics that already have stored headings.
 *
 * Gate 2 covers what gate 1 can't see: for every distinct `(unit, topic)` pair actually being
 * audited, confirms `extractTopicContent` resolves to non-empty content. This catches a topic with
 * no stored headings whose name-substring fallback also fails to match anything, an unknown unit,
 * and an unknown topic — none of which gate 1 inspects, since it only ever looks at topics that
 * have headings recorded. Skippable with `allowMissingMaterial` for an operator who has confirmed
 * the gap and wants to audit anyway without reference material for those topics.
 */
export function auditHeadingPreflight(
  questions: { unit_id: string; topic: string }[],
  units: Unit[],
  opts: { allowMissingMaterial?: boolean } = {},
): void {
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const touchedUnitIds = [...new Set(questions.map((q) => q.unit_id))];
  const materialsByUnit = new Map<string, string>();

  for (const unitId of touchedUnitIds) {
    const unit = unitsById.get(unitId);
    if (!unit) continue; // an unknown unit is reported by gate 2 below, scoped to the questions that actually reference it
    const materials = loadUnitMaterials(unit.id, units);
    materialsByUnit.set(unit.id, materials);
    const mismatches = findUnitHeadingMismatches(materials, unit.topics);
    if (mismatches.length > 0) {
      logger.error(formatHeadingPreflightError(unit.id, mismatches));
      process.exit(1);
    }
  }

  if (opts.allowMissingMaterial) return;

  const seen = new Set<string>();
  const unresolved: UnresolvedTopicRef[] = [];
  for (const q of questions) {
    const key = `${q.unit_id}::${q.topic}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const unit = unitsById.get(q.unit_id);
    if (!unit) {
      unresolved.push({ unitId: q.unit_id, topic: q.topic });
      continue;
    }

    let materials = materialsByUnit.get(unit.id);
    if (materials === undefined) {
      materials = loadUnitMaterials(unit.id, units);
      materialsByUnit.set(unit.id, materials);
    }

    if (!extractTopicContent(materials, q.topic, units)) {
      unresolved.push({ unitId: unit.id, topic: q.topic });
    }
  }

  if (unresolved.length > 0) {
    logger.error(formatMaterialPreflightError(unresolved));
    process.exit(1);
  }
}

// ── Mistral auditor ─────────────────────────────────────────────────────────

export async function fetchMistralQuestions(options: Options): Promise<QuestionRow[]> {
  let all = await fetchAllPages<QuestionRow>(
    supabase,
    'questions',
    (query) => {
      let q = query;
      if (options.unit) q = q.eq('unit_id', options.unit);
      if (options.difficulty) q = q.eq('difficulty', options.difficulty);
      if (options.type) q = q.eq('type', options.type);
      if (options.batchId) q = q.eq('batch_id', options.batchId);
      if (options.pendingOnly) q = q.eq('quality_status', 'pending');
      return q;
    },
    'id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, generated_by, options, acceptable_variations',
  );

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

async function auditMistralBatch(questions: AuditQuestionRow[], units: Unit[], sessionId?: string): Promise<MistralAuditResult[]> {
  return callMistralAuditGroup(questions, units, {
    model: MODELS.mistralAudit,
    temperature: 0.1,
    providerOnly: 'Mistral',
    sessionId,
  });
}

async function runMistralAudit(options: Options, units: Unit[]): Promise<void> {
  const promptHash = hashPrompt(renderedMistralAuditSystemPrompt());
  const filters = [
    options.unit && `unit=${options.unit}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
    options.limit && `limit=${options.limit}`,
    options.batchId && `batch=${options.batchId}`,
    options.pendingOnly && 'pending-only',
  ].filter(Boolean);

  console.log(`Fetching questions${filters.length ? ` (${filters.join(', ')})` : ''}...`);
  const questions = await fetchMistralQuestions(options);
  console.log(`Found ${questions.length} questions to audit with Mistral Large.\n`);

  if (questions.length === 0) {
    console.log('No questions found. Exiting.');
    return;
  }

  auditHeadingPreflight(questions, units, { allowMissingMaterial: options.allowMissingMaterial });

  if (options.llmBatch) {
    const pipelineBatchId = options.batchId ?? `audit-${options.unit ?? 'all'}-${Date.now()}`;
    await runSubmit(questions, options, pipelineBatchId, units);
    return;
  }

  const runId = options.batchId ?? `audit-mistral-${options.unit ?? 'all'}-${Date.now()}`;
  const sessionId = `${runId}:audit`;

  let currentDelay = BASE_INTER_GROUP_DELAY_MS;
  const sigint = installSigintFlag('finishing the in-flight group, then stopping...');

  const { results, summary: writeSummary, interrupted } = await runStreamingAudit<MistralAuditResult, ApplyAuditResultsSummary>({
    questions,
    groupSize: AUDIT_GROUP_SIZE,
    emptySummary: EMPTY_AUDIT_RESULTS_SUMMARY,
    mergeSummaries: mergeAuditResultsSummaries,
    auditGroupFn: async (batch, groupIndex, totalGroups) => {
      const groupResults = await auditGroupWithRetry(
        (group) => auditMistralBatch(group, units, sessionId),
        batch,
        {
          maxRetries: MAX_RETRIES,
          initialBackoffMs: INITIAL_BACKOFF_MS,
          maxBackoffMs: MAX_BACKOFF_MS,
          sleepFn: sleep,
          onSuccess: () => {
            currentDelay = nextInterGroupDelay(currentDelay, 'ok');
          },
          onRateLimited: (attempt, backoff) => {
            currentDelay = nextInterGroupDelay(currentDelay, 'rate-limited');
            logger.warn(`Rate limited (429) at group ${groupIndex}. Retry ${attempt + 1}/${MAX_RETRIES} in ${backoff / 1000}s... (base delay now ${currentDelay}ms)`);
          },
          onRateLimitExhausted: () => {
            logger.error(`Rate limit persists after ${MAX_RETRIES} retries at group ${groupIndex}`);
          },
          onNonRetryableError: (err) => {
            logger.error(`Group error at ${groupIndex}`, { error: err });
          },
        },
      );

      // Rate limiting between groups (adaptive — increases after 429s); skipped after the last one.
      if (groupIndex + 1 < totalGroups) {
        await sleep(currentDelay);
      }

      return groupResults;
    },
    applyGroupFn: options.writeDb
      ? (groupResults, batch) => applyAuditResultsForGroup(supabase, groupResults, batch, {
          auditorModel: MODELS.mistralAudit,
          pendingOnly: options.pendingOnly,
          promptHash,
        })
      : undefined,
    onGroupDone: (done, total) => {
      const pct = Math.round((done / total) * 100);
      process.stdout.write(`\r  Progress: ${done}/${total} (${pct}%)`);
    },
    shouldStop: sigint.interrupted,
  });

  sigint.uninstall();
  console.log('\n');

  // Export results to JSON if requested
  if (options.output) {
    ensureDirFor(options.output);
    writeFileSync(options.output, JSON.stringify(results, null, 2));
    console.log(`Results exported to ${options.output}\n`);
  }

  // ── Summary ──────────────────────────────────────────────
  // 6-gate: the criteria that actually determine flagged vs active
  const isGatePass = (r: MistralAuditResult) =>
    r.answer_correct && r.grammar_correct && r.no_hallucination && r.question_coherent &&
    r.natural_language && r.register_appropriate;

  const parseErrors = results.filter(r => r.notes.startsWith('PARSE_ERROR:') || r.notes.startsWith('API_ERROR:'));
  const evaluated = results.filter(r => !r.notes.startsWith('PARSE_ERROR:') && !r.notes.startsWith('API_ERROR:'));
  const evalCount = evaluated.length;
  const gatePass = evaluated.filter(r => isGatePass(r));
  const gateFlagged = evaluated.filter(r => !isGatePass(r));
  const all9Flagged = evaluated.filter(r =>
    !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent ||
    !r.natural_language || !r.register_appropriate || !r.difficulty_appropriate || !r.variations_valid ||
    !r.culturally_appropriate
  );
  const critical = evaluated.filter(r => r.severity === 'critical');
  const minor = evaluated.filter(r => r.severity === 'minor');

  console.log('='.repeat(60));
  console.log('MISTRAL AUDIT & REMEDIATION COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Model:             ${MODELS.mistralAudit}`);
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
    { key: 'natural_language', label: 'Unnatural French' },
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
    if (!f.natural_language) flags.push('UNNATURAL');
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
  for (const d of DIFFICULTIES) {
    const dResults = evaluated.filter(r => questionMap.get(r.id)?.difficulty === d);
    if (dResults.length === 0) continue;
    const dPass = dResults.filter(r => isGatePass(r)).length;
    console.log(`  ${d}: ${dPass}/${dResults.length} pass (${(dPass / dResults.length * 100).toFixed(1)}%)`);
  }

  // Post-relabeling difficulty distribution (6-gate passing only)
  const passingWithDiff = gatePass.map(r => {
    const current = questionMap.get(r.id)?.difficulty || 'unknown';
    const suggested = r.suggested_difficulty;
    const final = (suggested && isDifficulty(suggested) && suggested !== current)
      ? suggested : current;
    return final;
  });
  const diffDist: Record<string, number> = {};
  for (const d of passingWithDiff) diffDist[d] = (diffDist[d] || 0) + 1;
  console.log('\n' + '-'.repeat(60));
  console.log(`SERVED DIFFICULTY DISTRIBUTION (${gatePass.length} active, post-relabeling)`);
  console.log('-'.repeat(60));
  for (const d of DIFFICULTIES) {
    const count = diffDist[d] || 0;
    console.log(`  ${d}: ${count} (${(count / gatePass.length * 100).toFixed(1)}%)`);
  }

  if (options.writeDb) {
    summarizeAuditResultsWrite(writeSummary, { auditorModel: MODELS.mistralAudit, pendingOnly: options.pendingOnly });
  }

  // Group count derived from `results` (what actually ran), not `questions` (what was requested) —
  // a SIGINT-interrupted run stops short, and the call count should reflect that.
  const runUsage = sumResultUsage(results, chunk(results, AUDIT_GROUP_SIZE).length);
  console.log(`\n${formatUsageSummary(runUsage)}`);

  if (interrupted) {
    console.log('\nStopped by SIGINT after applying the in-flight group.');
    process.exit(1);
  }
}

async function runSubmit(questions: QuestionRow[], options: Options, pipelineBatchId: string, units: Unit[]): Promise<void> {
  const store = createSupabaseBatchJobStore(supabase);

  console.log(`Submitting ${questions.length} questions as an OpenRouter batch (model: ${MODELS.mistralAuditBatch})...`);

  const { jobId, providerBatchId, groupCount } = await submitAuditJob(questions, {
    store,
    submitBatchFn: submitBatch,
    systemPrompt: renderedMistralAuditSystemPrompt(),
    batchModel: MODELS.mistralAuditBatch,
    pipelineBatchId,
    units,
    unitId: options.unit,
  });

  console.log(`Submitted batch ${providerBatchId} (${groupCount} request group(s)) as job ${jobId}.`);
  const resumeFlags = options.writeDb ? ' --write-db' : '';
  console.log(`Resume with: npx tsx apps/pipeline/src/commands/questions-audit.ts --llm-batch-resume ${jobId}${resumeFlags}`);
}

async function runResume(options: Options, units: Unit[]): Promise<void> {
  const jobId = options.llmBatchResume!;
  const store = createSupabaseBatchJobStore(supabase);
  const fallbackSessionId = buildFallbackSessionId(jobId);
  const promptHash = hashPrompt(renderedMistralAuditSystemPrompt());

  const outcome = await resumeAuditJob(jobId, {
    store,
    pollUntilDoneFn: pollUntilDone,
    fetchQuestionsByIdsFn: (ids) => fetchQuestionsByIds(supabase, ids),
    syncAuditFn: (questions) => auditMistralBatch(questions, units, fallbackSessionId),
    applyResultsFn: (results, questions, auditorModel) =>
      applyAuditResults(supabase, results, questions, {
        auditorModel,
        pendingOnly: options.pendingOnly,
        promptHash,
      }),
    writeDb: !!options.writeDb,
    fallbackModel: MODELS.mistralAudit,
  });

  switch (outcome.kind) {
    case 'not_found':
      logger.error(`No batch job found with id ${jobId}`);
      process.exit(1);
      break;
    case 'already_applied':
      console.log(`Job ${jobId} was already applied. Nothing to do.`);
      break;
    case 'claim_lost':
      console.log(`Job ${jobId} was applied by a concurrent resume. Nothing to do.`);
      break;
    case 'still_running':
      console.log(`Batch still running (${outcome.requestCounts.completed}/${outcome.requestCounts.total} completed). Re-run this command later.`);
      process.exit(1);
      break;
    case 'poll_error':
      logger.error(`Polling the batch failed (${outcome.status ?? 'network error'}: ${outcome.message}). Nothing was written. Re-run this command later.`);
      process.exit(1);
      break;
    case 'terminal_no_fallback':
      logger.error(`Batch ended in status '${outcome.status}' with no results. Nothing was written — resubmit with --llm-batch.`);
      process.exit(1);
      break;
    case 'no_questions_resolved':
      logger.error(`None of job ${jobId}'s question ids resolve in its target table. Refusing to claim — nothing was written.`);
      process.exit(1);
      break;
    case 'preview_only':
      console.log('Batch is ready to apply. Re-run with --write-db to write results.');
      break;
    case 'applied_via_fallback':
      console.log(`Whole-batch failure — recovered via sync fallback (${MODELS.mistralAudit}).`);
      console.log(formatUsageSummary(outcome.usage));
      break;
    case 'applied':
      console.log('Batch results applied.');
      console.log(formatUsageSummary(outcome.usage));
      break;
  }
}

// ── Sonnet auditor ───────────────────────────────────────────────────────────

export async function fetchSonnetQuestions(options: Options): Promise<QuestionRow[]> {
  let all = await fetchAllPages<QuestionRow>(
    supabase,
    'questions',
    (query) => {
      let q = query;
      if (options.unit) q = q.eq('unit_id', options.unit);
      if (options.difficulty) q = q.eq('difficulty', options.difficulty);
      if (options.type) q = q.eq('type', options.type);
      if (options.model) q = q.eq('generated_by', options.model);
      if (options.batchId) q = q.eq('batch_id', options.batchId);
      if (options.pendingOnly) q = q.eq('quality_status', 'pending');
      return q;
    },
    'id, question, correct_answer, type, difficulty, topic, unit_id, writing_type, generated_by, options',
  );

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

/** The four gate criteria a valid Sonnet audit response must carry as explicit booleans. */
const SONNET_GATE_CRITERIA = ['answer_correct', 'grammar_correct', 'no_hallucination', 'question_coherent'] as const;

export async function auditSonnetQuestion(q: QuestionRow, units: Unit[], sessionId: string): Promise<SonnetAuditResult> {
  const optionsLine = q.type === 'multiple-choice' && q.options
    ? `\nOptions: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join(' | ')}`
    : '';

  const materialsBlock = buildAuditMaterialsBlock([{ unitId: q.unit_id, topic: q.topic }], units);
  const materialsSection = materialsBlock
    ? `Reference material for this question's topic, from the course markdown. Vocabulary, expressions, register, and phrasing that appear here are correct and in-scope for this course.\n\n${materialsBlock}\n\n`
    : '';

  const prompt = `${renderCoursePrompt(RAW_SONNET_PROMPT)}

${materialsSection}Question type: ${q.type}${q.writing_type ? ` (${q.writing_type})` : ''}
Topic: ${q.topic}
Difficulty: ${q.difficulty}

Question: ${q.question}${optionsLine}
Correct answer: ${q.correct_answer}`;

  const result = await callLlm({
    model: MODELS.sonnetAudit,
    maxTokens: 500,
    disableReasoning: true,
    messages: [{ role: 'user', content: prompt }],
    sessionId,
  });

  const text = result.text.trim();

  // A PARSE_ERROR result is excluded from both the flagged and passing branches downstream
  // (isParseError in sonnet-audit.ts), so the question stays pending regardless of these
  // placeholder booleans — they exist only to satisfy SonnetAuditResult's shape.
  const usage = result.usage
    ? {
        prompt_tokens: result.usage.promptTokens ?? null,
        completion_tokens: result.usage.completionTokens ?? null,
        reasoning_tokens: result.usage.reasoningTokens ?? null,
        cost_usd: result.usage.costUsd ?? null,
      }
    : null;
  const servedModel = result.servedModel ?? null;

  const buildPassthrough = (note: string): SonnetAuditResult => ({
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
    notes: note,
    usage,
    served_model: servedModel,
  });

  let parsed: Record<string, unknown>;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return buildPassthrough(`PARSE_ERROR: ${text.substring(0, 200)}`);
  }

  const missingCriteria = SONNET_GATE_CRITERIA.filter((c) => typeof parsed[c] !== 'boolean');
  if (missingCriteria.length > 0) {
    return buildPassthrough(`PARSE_ERROR: missing criteria [${missingCriteria.join(', ')}] in response: ${text.substring(0, 200)}`);
  }

  return {
    id: q.id,
    topic: q.topic,
    type: q.type,
    writing_type: q.writing_type,
    generated_by: q.generated_by,
    question: q.question,
    answer: q.correct_answer,
    answer_correct: parsed.answer_correct as boolean,
    grammar_correct: parsed.grammar_correct as boolean,
    no_hallucination: parsed.no_hallucination as boolean,
    question_coherent: parsed.question_coherent as boolean,
    notes: (parsed.notes as string) || '',
    usage,
    served_model: servedModel,
  };
}

async function runSonnetAudit(options: Options, units: Unit[]): Promise<void> {
  const promptHash = hashPrompt(renderCoursePrompt(RAW_SONNET_PROMPT));
  const filters = [
    options.unit && `unit=${options.unit}`,
    options.difficulty && `difficulty=${options.difficulty}`,
    options.type && `type=${options.type}`,
    options.model && `model=${options.model}`,
    options.limit && `limit=${options.limit}`,
    options.batchId && `batch=${options.batchId}`,
    options.pendingOnly && 'pending-only',
  ].filter(Boolean);

  console.log(`Fetching questions${filters.length ? ` (${filters.join(', ')})` : ''}...`);
  const questions = await fetchSonnetQuestions(options);
  console.log(`Found ${questions.length} questions to audit with Sonnet.\n`);

  if (questions.length === 0) {
    console.log('No questions found. Exiting.');
    return;
  }

  auditHeadingPreflight(questions, units, { allowMissingMaterial: options.allowMissingMaterial });

  const runId = options.batchId ?? `audit-sonnet-${options.unit ?? 'all'}-${Date.now()}`;
  const sessionId = `${runId}:audit`;

  const sigint = installSigintFlag('finishing the in-flight group, then stopping...');

  const { results, summary: writeSummary, interrupted } = await runStreamingAudit<SonnetAuditResult, ApplySonnetAuditResultsSummary>({
    questions,
    groupSize: AUDIT_GROUP_SIZE,
    emptySummary: EMPTY_SONNET_AUDIT_RESULTS_SUMMARY,
    mergeSummaries: mergeSonnetAuditResultsSummaries,
    auditGroupFn: async (batch) => {
      const batchResults = await Promise.allSettled(
        batch.map(q => auditSonnetQuestion(q, units, sessionId)),
      );

      const groupResults: SonnetAuditResult[] = [];
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          groupResults.push(r.value);
        } else {
          logger.error('Error auditing question', { reason: r.reason });
        }
      }
      return groupResults;
    },
    applyGroupFn: options.writeDb
      ? (groupResults) => (groupResults.length > 0
          ? applySonnetAuditResultsForGroup(supabase, groupResults, MODELS.sonnetAudit, promptHash)
          : Promise.resolve(EMPTY_SONNET_AUDIT_RESULTS_SUMMARY))
      : undefined,
    onGroupDone: (done, total) => {
      const pct = Math.round((done / total) * 100);
      process.stdout.write(`\r  Progress: ${done}/${total} (${pct}%)`);
    },
    shouldStop: sigint.interrupted,
  });

  sigint.uninstall();
  console.log('\n');

  // Export results to JSON if --export specified
  if (options.output) {
    ensureDirFor(options.output);
    writeFileSync(options.output, JSON.stringify(results, null, 2));
    console.log(`Results exported to ${options.output}\n`);
  }

  // Summary
  const flagged = results.filter(r =>
    !r.answer_correct || !r.grammar_correct || !r.no_hallucination || !r.question_coherent
  );
  const parseErrors = results.filter(r => r.notes.startsWith('PARSE_ERROR:'));

  console.log('='.repeat(60));
  console.log('SONNET AUDIT COMPLETE (4-gate)');
  console.log('='.repeat(60));
  console.log(`  Model:           ${MODELS.sonnetAudit}`);
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
    const resultsByModel = new Map(models.map(m => [m, results.filter(r => (r.generated_by || 'unknown') === m)]));

    console.log('\n' + '-'.repeat(60));
    console.log('PASS RATE BY MODEL');
    console.log('-'.repeat(60));
    for (const m of models) {
      const modelResults = resultsByModel.get(m)!;
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
      const mr = resultsByModel.get(m)!;
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

  if (options.writeDb) {
    summarizeSonnetAuditResultsWrite(writeSummary, options.pendingOnly);
  }

  // One call per question (unlike Mistral's grouped audit), so calls = results.length.
  const runUsage = emptyUsageTotals();
  runUsage.calls = results.length;
  for (const r of results) {
    if (!r.usage) continue;
    runUsage.prompt_tokens += r.usage.prompt_tokens ?? 0;
    runUsage.completion_tokens += r.usage.completion_tokens ?? 0;
    runUsage.reasoning_tokens += r.usage.reasoning_tokens ?? 0;
    runUsage.cost_usd += r.usage.cost_usd ?? 0;
  }
  console.log(`\n${formatUsageSummary(runUsage)}`);

  if (interrupted) {
    console.log('\nStopped by SIGINT after applying the in-flight group.');
    process.exit(1);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const options = cli.parse();
  setLogLevel(levelFromFlags(options));

  // Batch bookkeeping (llm_batch_jobs) always needs a write-capable client, independent of
  // --write-db, which gates writes to questions specifically.
  supabase = createScriptSupabase({ write: options.writeDb || options.llmBatch || !!options.llmBatchResume });

  // Needed by every path below to ground the auditor in the material each question's topic was
  // generated from — fetched once up front rather than per-run-path.
  const units = await fetchUnitsFromDb(supabase);

  if (options.llmBatchResume) {
    await runResume(options, units);
    return;
  }

  if (options.auditor === 'sonnet') {
    await runSonnetAudit(options, units);
  } else {
    await runMistralAudit(options, units);
  }
}

runIfMain(import.meta.url, main);
