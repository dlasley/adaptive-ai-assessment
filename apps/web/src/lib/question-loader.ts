import { supabaseAdmin, isSupabaseAdminAvailable } from './supabase-admin';
import { Question } from '@adaptive/shared/types';
import { getQuestionWeight } from './leitner';
import type { Difficulty, QuestionType, WritingType } from '@adaptive/shared/enums';
import { matchMetaQuestionPattern } from '@adaptive/shared/meta-question-filter';
import { createLogger } from './logger';
import { supabaseErrorFields } from './supabase-error';

const logger = createLogger('question-loader');

/**
 * Database question row type
 */
interface DBQuestion {
  id: string;
  question: string;
  correct_answer: string;
  explanation: string | null;
  unit_id: string;
  topic: string;
  difficulty: Difficulty;
  type: QuestionType;
  options: string[] | null;
  acceptable_variations: string[];
  writing_type: WritingType | null;
  hints: string[];
  has_complete_sentence_requirement: boolean;
}

/** The columns dbToQuestion reads. Listed explicitly so a column added to the table later is not served to students by default. */
const QUESTION_COLUMNS =
  'id, question, correct_answer, explanation, unit_id, topic, difficulty, type, options, acceptable_variations, writing_type, hints, has_complete_sentence_requirement';

/**
 * Convert database row to Question type
 */
function dbToQuestion(row: DBQuestion): Question {
  return {
    id: row.id,
    question: row.question,
    correctAnswer: row.correct_answer,
    explanation: row.explanation || undefined,
    unitId: row.unit_id,
    topic: row.topic,
    difficulty: row.difficulty,
    type: row.type,
    options: row.options || undefined,
    acceptableVariations: row.acceptable_variations,
    writingType: row.writing_type as Question['writingType'],
    hints: row.hints,
    hasCompleteSentenceRequirement: row.has_complete_sentence_requirement,
  };
}

const PAGE_SIZE = 1000;

/**
 * Load all questions from database (paginated to bypass Supabase 1000-row default limit)
 */
export async function loadAllQuestions(): Promise<Question[]> {
  if (!isSupabaseAdminAvailable()) {
    logger.warn('Supabase not available. No questions loaded.');
    return [];
  }

  try {
    const allData: DBQuestion[] = [];
    let page = 0;

    while (true) {
      const { data, error } = await supabaseAdmin!
        .from('questions')
        .select(QUESTION_COLUMNS)
        .eq('quality_status', 'active')
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (error) {
        logger.error('Error loading questions', supabaseErrorFields(error));
        return allData.length > 0 ? allData.map(dbToQuestion).filter(q => !isMetaQuestion(q)) : [];
      }

      if (!data || data.length === 0) break;
      allData.push(...(data as unknown as DBQuestion[]));
      if (data.length < PAGE_SIZE) break;
      page++;
    }

    const questions = allData.map(dbToQuestion);

    // Filter out meta-questions
    const validQuestions = questions.filter(q => !isMetaQuestion(q));

    if (questions.length !== validQuestions.length) {
      logger.debug(`Filtered out ${questions.length - validQuestions.length} meta-questions`);
    }

    return validQuestions;
  } catch (error) {
    logger.error('Error loading questions', supabaseErrorFields(error));
    return [];
  }
}

/**
 * Look up specific questions by id, straight from the questions table rather
 * than the servable pool — no quality_status or meta-question filtering, since
 * a route grading an already-answered question needs its actual stored
 * correct answer regardless of the question's current serving status. Ids
 * with no matching row (a stale or spoofed id) are simply absent from the
 * returned map rather than causing an error.
 */
export async function loadQuestionsByIds(ids: string[]): Promise<Map<string, Question>> {
  if (!isSupabaseAdminAvailable() || ids.length === 0) return new Map();

  try {
    const { data, error } = await supabaseAdmin!
      .from('questions')
      .select(QUESTION_COLUMNS)
      .in('id', ids);

    if (error || !data) {
      logger.error('Error loading questions by id', supabaseErrorFields(error));
      return new Map();
    }

    return new Map((data as unknown as DBQuestion[]).map((row) => [row.id, dbToQuestion(row)]));
  } catch (error) {
    logger.error('Error loading questions by id', supabaseErrorFields(error));
    return new Map();
  }
}

/**
 * Filter out meta-questions about learning philosophy, motivation, or personal teacher information.
 * These questions don't test French language knowledge. Logs the id and matched rule (never the
 * question/explanation text) for every drop, so a filtered question stays traceable.
 */
function isMetaQuestion(question: Question): boolean {
  const matched = matchMetaQuestionPattern(question.question, question.explanation);

  if (!matched) return false;

  logger.info('Dropped question: matched meta-question filter', {
    questionId: question.id,
    rule: matched.rule,
  });
  return true;
}

/**
 * Result from question selection including any warnings
 */
export interface SelectionResult {
  questions: Question[];
  warnings: string[];
  requestedCount: number;
  actualCount: number;
}

/**
 * Filter and randomize questions based on criteria
 */
export function selectQuestions(
  allQuestions: Question[],
  criteria: {
    unitId?: string;
    topic?: string;
    difficulty?: string;
    numQuestions: number;
    /** Allowed question types (if not specified, all types allowed) */
    allowedTypes?: Question['type'][];
    /** Distribution ratios for each type (should sum to 1.0) */
    typeDistribution: Partial<Record<Question['type'], number>>;
    /** Leitner box weights for adaptive selection (questionId -> box number) */
    leitnerWeights?: Map<string, number>;
  }
): SelectionResult {
  const warnings: string[] = [];
  let filtered = allQuestions;

  // Log initial pool
  const initialWriting = allQuestions.filter(q => q.type === 'writing').length;
  logger.debug(`Initial pool: ${allQuestions.length} total (${initialWriting} writing)`, {
    unitId: criteria.unitId,
    topic: criteria.topic,
    difficulty: criteria.difficulty,
    allowedTypes: criteria.allowedTypes,
  });

  // Filter by allowed types if specified
  if (criteria.allowedTypes && criteria.allowedTypes.length > 0) {
    filtered = filtered.filter(q => criteria.allowedTypes!.includes(q.type));
    logger.debug(`After type filter: ${filtered.length} total`);
  }

  // Filter by unit if specified
  // Include questions with unitId='all' as they apply to any unit
  if (criteria.unitId && criteria.unitId !== 'all') {
    filtered = filtered.filter(q => q.unitId === criteria.unitId || q.unitId === 'all');
    const writingAfterUnit = filtered.filter(q => q.type === 'writing').length;
    logger.debug(`After unit filter: ${filtered.length} total (${writingAfterUnit} writing)`);
  }

  // Filter by topic if specified
  if (criteria.topic) {
    const topicLower = criteria.topic.toLowerCase();
    filtered = filtered.filter(q =>
      q.topic.toLowerCase() === topicLower
    );
    const writingAfterTopic = filtered.filter(q => q.type === 'writing').length;
    logger.debug(`After topic filter: ${filtered.length} total (${writingAfterTopic} writing)`);
  }

  // Filter by difficulty if specified
  if (criteria.difficulty) {
    filtered = filtered.filter(q => q.difficulty === criteria.difficulty);
    const writingAfterDifficulty = filtered.filter(q => q.type === 'writing').length;
    logger.debug(`After difficulty filter: ${filtered.length} total (${writingAfterDifficulty} writing)`);
  }

  const finalSelection = selectByDistribution(filtered, criteria.numQuestions, criteria.typeDistribution, warnings, criteria.leitnerWeights);

  // Check if we got fewer questions than requested
  if (finalSelection.length < criteria.numQuestions) {
    warnings.push(`Only ${finalSelection.length} questions available (requested ${criteria.numQuestions})`);
  }

  // Log selection stats
  const typeCounts = finalSelection.reduce((acc, q) => {
    acc[q.type] = (acc[q.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logger.debug(`Question pool: ${filtered.length} total; selected ${finalSelection.length}`, { typeCounts });
  if (warnings.length > 0) {
    logger.warn(`Question selection warnings: ${warnings.join(', ')}`);
  }

  return {
    questions: finalSelection,
    warnings,
    requestedCount: criteria.numQuestions,
    actualCount: finalSelection.length,
  };
}

/**
 * Weighted random shuffle: higher-weight questions appear first.
 * Uses weighted random sampling without replacement.
 */
function weightedShuffle(
  questions: Question[],
  leitnerWeights: Map<string, number>
): Question[] {
  const remaining = questions.map((q) => ({
    question: q,
    weight: getQuestionWeight(leitnerWeights.get(q.id) ?? null),
  }));

  const result: Question[] = [];

  while (remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, e) => sum + e.weight, 0);
    let random = Math.random() * totalWeight;
    let selectedIdx = 0;

    for (let i = 0; i < remaining.length; i++) {
      random -= remaining[i].weight;
      if (random <= 0) {
        selectedIdx = i;
        break;
      }
    }

    result.push(remaining[selectedIdx].question);
    remaining.splice(selectedIdx, 1);
  }

  return result;
}

/**
 * Select questions based on type distribution ratios
 */
function selectByDistribution(
  questions: Question[],
  numQuestions: number,
  distribution: Partial<Record<Question['type'], number>>,
  warnings: string[],
  leitnerWeights?: Map<string, number>
): Question[] {
  const selected: Question[] = [];

  // Group questions by type
  const byType: Record<string, Question[]> = {};
  for (const q of questions) {
    if (!byType[q.type]) byType[q.type] = [];
    byType[q.type].push(q);
  }

  // Shuffle each type group (weighted if Leitner active, random otherwise)
  for (const type in byType) {
    byType[type] = leitnerWeights
      ? weightedShuffle(byType[type], leitnerWeights)
      : byType[type].sort(() => Math.random() - 0.5);
  }

  // Calculate desired counts for each type using floor, then distribute remainder
  const desiredCounts: Record<string, number> = {};
  const entries = Object.entries(distribution).filter(([, ratio]) => ratio > 0);

  // First pass: floor all values
  let allocated = 0;
  for (const [type, ratio] of entries) {
    desiredCounts[type] = Math.floor(numQuestions * ratio);
    allocated += desiredCounts[type];
  }

  // Second pass: distribute remainder to types with highest fractional parts
  const remainder = numQuestions - allocated;
  if (remainder > 0) {
    const fractionals = entries.map(([type, ratio]) => ({
      type,
      fractional: (numQuestions * ratio) - Math.floor(numQuestions * ratio)
    })).sort((a, b) => b.fractional - a.fractional);

    for (let i = 0; i < remainder && i < fractionals.length; i++) {
      desiredCounts[fractionals[i].type]++;
    }
  }

  // Select from each type based on distribution
  for (const [type, desiredCount] of Object.entries(desiredCounts)) {
    const available = byType[type] || [];
    const toSelect = Math.min(desiredCount, available.length);

    if (toSelect < desiredCount) {
      warnings.push(`Only ${available.length} ${type} questions available (wanted ${desiredCount})`);
    }

    selected.push(...available.slice(0, toSelect));
  }

  // If we're short on questions, try to fill from any available type
  if (selected.length < numQuestions) {
    const usedIds = new Set(selected.map(q => q.id));
    const unused = questions.filter(q => !usedIds.has(q.id));
    const shuffledUnused = unused.sort(() => Math.random() - 0.5);
    const needed = numQuestions - selected.length;
    selected.push(...shuffledUnused.slice(0, needed));
  }

  // Shuffle final selection
  return selected.sort(() => Math.random() - 0.5);
}
