import { supabase, isSupabaseAvailable } from './supabase';
import { Question } from '@/types';

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
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  type: 'multiple-choice' | 'true-false' | 'fill-in-blank' | 'writing';
  options: string[] | null;
  acceptable_variations: string[];
  writing_type: string | null;
  hints: string[];
  requires_complete_sentence: boolean;
}

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
    requiresCompleteSentence: row.requires_complete_sentence,
  };
}

/**
 * Load all questions from database
 */
export async function loadAllQuestions(): Promise<Question[]> {
  if (!isSupabaseAvailable()) {
    console.warn('Supabase not available. No questions loaded.');
    return [];
  }

  try {
    const { data, error } = await supabase!
      .from('questions')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error loading questions:', error);
      return [];
    }

    const questions = (data || []).map(dbToQuestion);

    // Filter out meta-questions
    const validQuestions = questions.filter(q => !isMetaQuestion(q));

    if (process.env.NODE_ENV === 'development' && questions.length !== validQuestions.length) {
      console.log(`🚫 Filtered out ${questions.length - validQuestions.length} meta-questions`);
    }

    return validQuestions;
  } catch (error) {
    console.error('Error loading questions:', error);
    return [];
  }
}

/**
 * Load questions for a specific unit
 */
export async function loadUnitQuestions(unitId: string): Promise<Question[]> {
  if (!isSupabaseAvailable()) {
    console.warn('Supabase not available. No questions loaded.');
    return [];
  }

  try {
    const { data, error } = await supabase!
      .from('questions')
      .select('*')
      .or(`unit_id.eq.${unitId},unit_id.eq.all`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`Error loading questions for unit ${unitId}:`, error);
      return [];
    }

    const questions = (data || []).map(dbToQuestion);

    // Filter out meta-questions
    return questions.filter(q => !isMetaQuestion(q));
  } catch (error) {
    console.error(`Error loading questions for unit ${unitId}:`, error);
    return [];
  }
}

/**
 * Filter out meta-questions about learning philosophy, motivation, or personal teacher information
 * These questions don't test French language knowledge
 */
export function isMetaQuestion(question: Question): boolean {
  const questionText = question.question.toLowerCase();
  const explanationText = (question.explanation || '').toLowerCase();

  // Patterns that indicate meta-questions about learning philosophy
  const metaPatterns = [
    /making mistakes.*(discourage|should|part of learning)/i,
    /language acquisition/i,
    /growth mindset/i,
    /willingness to learn/i,
    /learning process/i,
    /most important factor.*success/i,
    /effort.*language.*success/i,
    /learning.*language.*success/i,
    /mr\.\s+/i,  // Questions about specific teacher
    /mrs\.\s+/i,
    /practice.*key.*success/i,
    /consistency.*key/i,
    /language learning.*emphasized/i
  ];

  // Check if question or explanation matches any meta pattern
  return metaPatterns.some(pattern =>
    pattern.test(questionText) || pattern.test(explanationText)
  );
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
    typeDistribution?: Partial<Record<Question['type'], number>>;
  }
): SelectionResult {
  const warnings: string[] = [];
  let filtered = allQuestions;

  // Log initial pool
  if (process.env.NODE_ENV === 'development') {
    const initialWriting = allQuestions.filter(q => q.type === 'writing').length;
    console.log(`\n📦 Initial pool: ${allQuestions.length} total (${initialWriting} writing)`);
    console.log(`   Criteria: unit=${criteria.unitId}, topic=${criteria.topic}, difficulty=${criteria.difficulty}`);
    if (criteria.allowedTypes) {
      console.log(`   Allowed types: ${criteria.allowedTypes.join(', ')}`);
    }
  }

  // Filter by allowed types if specified
  if (criteria.allowedTypes && criteria.allowedTypes.length > 0) {
    filtered = filtered.filter(q => criteria.allowedTypes!.includes(q.type));
    if (process.env.NODE_ENV === 'development') {
      console.log(`   After type filter: ${filtered.length} total`);
    }
  }

  // Filter by unit if specified
  // Include questions with unitId='all' as they apply to any unit
  if (criteria.unitId && criteria.unitId !== 'all') {
    filtered = filtered.filter(q => q.unitId === criteria.unitId || q.unitId === 'all');
    if (process.env.NODE_ENV === 'development') {
      const writingAfterUnit = filtered.filter(q => q.type === 'writing').length;
      console.log(`   After unit filter: ${filtered.length} total (${writingAfterUnit} writing)`);
    }
  }

  // Filter by topic if specified
  if (criteria.topic) {
    const topicLower = criteria.topic.toLowerCase();
    filtered = filtered.filter(q =>
      q.topic.toLowerCase() === topicLower
    );
    if (process.env.NODE_ENV === 'development') {
      const writingAfterTopic = filtered.filter(q => q.type === 'writing').length;
      console.log(`   After topic filter: ${filtered.length} total (${writingAfterTopic} writing)`);
    }
  }

  // Filter by difficulty if specified
  if (criteria.difficulty) {
    filtered = filtered.filter(q => q.difficulty === criteria.difficulty);
    if (process.env.NODE_ENV === 'development') {
      const writingAfterDifficulty = filtered.filter(q => q.type === 'writing').length;
      console.log(`   After difficulty filter: ${filtered.length} total (${writingAfterDifficulty} writing)`);
    }
  }

  // Use type distribution if provided, otherwise use default behavior
  let finalSelection: Question[];

  if (criteria.typeDistribution) {
    // Select questions based on specified distribution
    finalSelection = selectByDistribution(filtered, criteria.numQuestions, criteria.typeDistribution, warnings);
  } else {
    // Legacy behavior: 30% writing, 70% traditional
    const writingQuestions = filtered.filter(q => q.type === 'writing');
    const traditionalQuestions = filtered.filter(q => q.type !== 'writing');

    const desiredWritingCount = Math.min(
      Math.ceil(criteria.numQuestions * 0.3),
      writingQuestions.length
    );
    const desiredTraditionalCount = criteria.numQuestions - desiredWritingCount;

    const shuffledWriting = [...writingQuestions].sort(() => Math.random() - 0.5);
    const shuffledTraditional = [...traditionalQuestions].sort(() => Math.random() - 0.5);

    const selectedWriting = shuffledWriting.slice(0, desiredWritingCount);
    const selectedTraditional = shuffledTraditional.slice(0, desiredTraditionalCount);

    finalSelection = [...selectedWriting, ...selectedTraditional].sort(() => Math.random() - 0.5);
  }

  // Check if we got fewer questions than requested
  if (finalSelection.length < criteria.numQuestions) {
    warnings.push(`Only ${finalSelection.length} questions available (requested ${criteria.numQuestions})`);
  }

  // Log selection stats in development
  if (process.env.NODE_ENV === 'development') {
    const typeCounts = finalSelection.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`🎯 Question pool: ${filtered.length} total`);
    console.log(`📋 Selected ${finalSelection.length} questions:`, typeCounts);
    if (warnings.length > 0) {
      console.log(`⚠️  Warnings: ${warnings.join(', ')}`);
    }
  }

  return {
    questions: finalSelection,
    warnings,
    requestedCount: criteria.numQuestions,
    actualCount: finalSelection.length,
  };
}

/**
 * Select questions based on type distribution ratios
 */
function selectByDistribution(
  questions: Question[],
  numQuestions: number,
  distribution: Partial<Record<Question['type'], number>>,
  warnings: string[]
): Question[] {
  const selected: Question[] = [];

  // Group questions by type
  const byType: Record<string, Question[]> = {};
  for (const q of questions) {
    if (!byType[q.type]) byType[q.type] = [];
    byType[q.type].push(q);
  }

  // Shuffle each type group
  for (const type in byType) {
    byType[type] = byType[type].sort(() => Math.random() - 0.5);
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

/**
 * Get available topics for a unit
 */
export async function getAvailableTopics(unitId?: string): Promise<string[]> {
  const questions = unitId && unitId !== 'all'
    ? await loadUnitQuestions(unitId)
    : await loadAllQuestions();

  const topicsSet = new Set(questions.map(q => q.topic));
  return Array.from(topicsSet).sort();
}
