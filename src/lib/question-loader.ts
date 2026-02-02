import fs from 'fs';
import path from 'path';
import { Question } from '@/types';

/**
 * Load all questions from JSON file
 */
export function loadAllQuestions(): Question[] {
  try {
    const questionsPath = path.join(process.cwd(), 'data', 'questions.json');

    if (!fs.existsSync(questionsPath)) {
      console.warn('Questions file not found. Please run: npm run generate-questions');
      return [];
    }

    const data = fs.readFileSync(questionsPath, 'utf-8');
    const allQuestions: Question[] = JSON.parse(data);

    // Filter out meta-questions
    const validQuestions = allQuestions.filter(q => !isMetaQuestion(q));

    if (process.env.NODE_ENV === 'development' && allQuestions.length !== validQuestions.length) {
      console.log(`🚫 Filtered out ${allQuestions.length - validQuestions.length} meta-questions`);
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
export function loadUnitQuestions(unitId: string): Question[] {
  try {
    const unitPath = path.join(process.cwd(), 'data', `questions-${unitId}.json`);

    if (!fs.existsSync(unitPath)) {
      // Fallback to loading from all questions
      const allQuestions = loadAllQuestions();
      return allQuestions.filter(q => q.unitId === unitId);
    }

    const data = fs.readFileSync(unitPath, 'utf-8');
    const questions: Question[] = JSON.parse(data);

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
    /mr\.\s+ayon/i,  // Questions about specific teacher
    /mrs\.\s+ayon/i,
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
 * Filter and randomize questions based on criteria
 */
export function selectQuestions(
  allQuestions: Question[],
  criteria: {
    unitId?: string;
    topic?: string;
    difficulty?: string;
    numQuestions: number;
  }
): Question[] {
  let filtered = allQuestions;

  // Log initial pool
  if (process.env.NODE_ENV === 'development') {
    const initialWriting = allQuestions.filter(q => q.type === 'writing').length;
    console.log(`\n📦 Initial pool: ${allQuestions.length} total (${initialWriting} writing)`);
    console.log(`   Criteria: unit=${criteria.unitId}, topic=${criteria.topic}, difficulty=${criteria.difficulty}`);
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

  // Separate writing and traditional questions for guaranteed mix
  const writingQuestions = filtered.filter(q => q.type === 'writing');
  const traditionalQuestions = filtered.filter(q => q.type !== 'writing');

  // Calculate desired writing question count (aim for 30% if available)
  const desiredWritingCount = Math.min(
    Math.ceil(criteria.numQuestions * 0.3),
    writingQuestions.length
  );
  const desiredTraditionalCount = criteria.numQuestions - desiredWritingCount;

  // Shuffle each type separately
  const shuffledWriting = [...writingQuestions].sort(() => Math.random() - 0.5);
  const shuffledTraditional = [...traditionalQuestions].sort(() => Math.random() - 0.5);

  // Select from each type
  const selectedWriting = shuffledWriting.slice(0, desiredWritingCount);
  const selectedTraditional = shuffledTraditional.slice(0, desiredTraditionalCount);

  // Combine and shuffle the final selection
  const finalSelection = [...selectedWriting, ...selectedTraditional].sort(() => Math.random() - 0.5);

  // Log selection stats in development
  if (process.env.NODE_ENV === 'development') {
    console.log(`🎯 Question pool: ${filtered.length} total (${writingQuestions.length} writing, ${traditionalQuestions.length} traditional)`);
    console.log(`📋 Selected ${finalSelection.length} questions (${selectedWriting.length} writing, ${selectedTraditional.length} traditional)`);
  }

  // Return final selection
  return finalSelection;
}

/**
 * Get available topics for a unit
 */
export function getAvailableTopics(unitId?: string): string[] {
  const questions = unitId && unitId !== 'all'
    ? loadUnitQuestions(unitId)
    : loadAllQuestions();

  const topicsSet = new Set(questions.map(q => q.topic));
  return Array.from(topicsSet).sort();
}
