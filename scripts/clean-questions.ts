/**
 * Script to remove problematic meta/administrative questions from the question bank
 */

import fs from 'fs';
import path from 'path';

// Patterns to identify problematic questions
const FORBIDDEN_PATTERNS = [
  /monsieur /i,
  /m\. /i,
  /four key skills/i,
  /key skills/i,
  /course structure/i,
  /class structure/i,
  /chromebook/i,
  /daily materials needed/i,
  /materials needed for class/i,
  /teacher'?s name/i,
  /your teacher/i,
  /potluck/i,
  /role plays/i,
  /end of the semester/i,
];

function isProblematicQuestion(question: any): boolean {
  const textToCheck = `${question.question} ${question.explanation || ''} ${JSON.stringify(question.options || [])}`;

  return FORBIDDEN_PATTERNS.some(pattern => pattern.test(textToCheck));
}

function cleanQuestionFile(filePath: string): void {
  console.log(`\nProcessing ${path.basename(filePath)}...`);

  const rawData = fs.readFileSync(filePath, 'utf-8');
  const questions = JSON.parse(rawData);

  const originalCount = questions.length;
  const cleanedQuestions = questions.filter((q: any) => !isProblematicQuestion(q));
  const removedCount = originalCount - cleanedQuestions.length;

  if (removedCount > 0) {
    fs.writeFileSync(filePath, JSON.stringify(cleanedQuestions, null, 2));
    console.log(`  ✅ Removed ${removedCount} problematic questions`);
    console.log(`  📊 ${cleanedQuestions.length} questions remaining (was ${originalCount})`);
  } else {
    console.log(`  ✓ No problematic questions found`);
  }
}

// Process all question files
const dataDir = path.join(process.cwd(), 'data');
const questionFiles = [
  'questions.json',
  'questions-introduction.json',
  'questions-unit-2.json',
  'questions-unit-3.json',
];

console.log('🧹 Starting question cleanup...');

for (const file of questionFiles) {
  const filePath = path.join(dataDir, file);
  if (fs.existsSync(filePath)) {
    cleanQuestionFile(filePath);
  }
}

console.log('\n✅ Cleanup complete!');
