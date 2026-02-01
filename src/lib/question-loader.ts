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
    return JSON.parse(data);
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
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading questions for unit ${unitId}:`, error);
    return [];
  }
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

  // Filter by unit if specified
  if (criteria.unitId && criteria.unitId !== 'all') {
    filtered = filtered.filter(q => q.unitId === criteria.unitId);
  }

  // Filter by topic if specified
  if (criteria.topic) {
    const topicLower = criteria.topic.toLowerCase();
    filtered = filtered.filter(q =>
      q.topic.toLowerCase() === topicLower
    );
  }

  // Filter by difficulty if specified
  if (criteria.difficulty) {
    filtered = filtered.filter(q => q.difficulty === criteria.difficulty);
  }

  // Shuffle questions
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);

  // Return requested number of questions
  return shuffled.slice(0, criteria.numQuestions);
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
