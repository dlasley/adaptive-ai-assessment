/**
 * Remove a specific question by ID from question files
 * Usage: npx tsx scripts/remove-question.ts "question-id"
 */

import fs from 'fs';
import path from 'path';

const questionId = process.argv[2];

if (!questionId) {
  console.error('Usage: npx tsx scripts/remove-question.ts "question-id"');
  process.exit(1);
}

console.log(`\n🗑️  Removing question: ${questionId}\n`);

// Files to update
const files = [
  'data/questions.json',
  'data/questions-unit-3.json'
];

let totalRemoved = 0;

for (const filePath of files) {
  const fullPath = path.join(process.cwd(), filePath);

  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  Skipping ${filePath} (not found)`);
    continue;
  }

  const questions = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  const beforeCount = questions.length;

  const filtered = questions.filter((q: any) => q.id !== questionId);
  const afterCount = filtered.length;
  const removed = beforeCount - afterCount;

  if (removed > 0) {
    fs.writeFileSync(fullPath, JSON.stringify(filtered, null, 2));
    console.log(`✅ ${filePath}: Removed ${removed} question(s) (${beforeCount} → ${afterCount})`);
    totalRemoved += removed;
  } else {
    console.log(`ℹ️  ${filePath}: No matching questions found`);
  }
}

console.log(`\n✨ Total removed: ${totalRemoved} question(s)\n`);
