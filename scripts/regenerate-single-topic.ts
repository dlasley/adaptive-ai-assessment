/**
 * Regenerate questions for a single topic
 * Usage: npx tsx scripts/regenerate-single-topic.ts "unit-2" "Numbers 20-100" "advanced"
 */

import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// Load environment variables
config({ path: '.env.local' });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Get CLI arguments
const [unitId, topic, difficulty] = process.argv.slice(2);

if (!unitId || !topic || !difficulty) {
  console.error('Usage: npx tsx scripts/regenerate-single-topic.ts <unitId> <topic> <difficulty>');
  console.error('Example: npx tsx scripts/regenerate-single-topic.ts "unit-2" "Numbers 20-100" "advanced"');
  process.exit(1);
}

const QUESTIONS_PER_TOPIC = 10;

async function regenerateTopic() {
  console.log(`\n🔄 Regenerating questions for:`);
  console.log(`   Unit: ${unitId}`);
  console.log(`   Topic: ${topic}`);
  console.log(`   Difficulty: ${difficulty}\n`);

  // Load existing questions for this unit
  const unitFilePath = path.join(process.cwd(), 'data', `questions-${unitId}.json`);

  if (!fs.existsSync(unitFilePath)) {
    console.error(`❌ File not found: ${unitFilePath}`);
    process.exit(1);
  }

  const existingQuestions = JSON.parse(fs.readFileSync(unitFilePath, 'utf-8'));

  // Load unit materials
  const { loadUnitMaterials, extractTopicContent } = await import('../src/lib/learning-materials');
  const unitMaterials = loadUnitMaterials(unitId);
  const topicContent = extractTopicContent(unitMaterials, topic);

  console.log(`📚 Generating ${QUESTIONS_PER_TOPIC} questions...`);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are a French language teacher creating practice questions for students.

Based on the following learning materials about "${topic}", create ${QUESTIONS_PER_TOPIC} practice questions at a ${difficulty} level.

Learning Materials:
${topicContent}

CRITICAL: ONLY CREATE QUESTIONS ABOUT FRENCH LANGUAGE LEARNING

❌ ABSOLUTELY FORBIDDEN - DO NOT create questions about:
- Meta-questions about learning philosophy, mistakes, growth mindset, etc.
- Teacher information, course structure, classroom policies, etc.

✅ ONLY create questions testing knowledge of:
- French vocabulary, grammar, usage
- French culture, geography, traditions
- Practical communication in French
- Translation between French and English

IMPORTANT INSTRUCTIONS:
1. Create EXACTLY ${QUESTIONS_PER_TOPIC} questions
2. Mix question types: multiple-choice, fill-in-blank, true-false
3. Make questions appropriate for ${difficulty} level students
4. Include clear, unambiguous correct answers
5. Add brief explanations for the correct answers IN ENGLISH (NOT in French)
6. Return ONLY valid JSON matching this exact format:

{
  "questions": [
    {
      "id": "q1",
      "question": "Question text here?",
      "type": "multiple-choice",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option B",
      "explanation": "Brief explanation in English of why this is correct"
    }
  ]
}

Question type options: "multiple-choice", "fill-in-blank", "true-false"

For fill-in-blank questions:
- Use underscores like: "Je _____ français." (I speak French)
- correctAnswer should be the word(s) to fill in
- No options array needed
- Explanation must be in English

For true-false questions:
- options should be ["Vrai", "Faux"]
- correctAnswer should be "Vrai" or "Faux"

Return ONLY the JSON, no additional text.`
      }]
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

    // Extract JSON
    let jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in response');
    }

    let jsonText = jsonMatch[0];

    // Clean up common JSON issues
    jsonText = jsonText
      .replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas

    let parsedResponse;
    try {
      parsedResponse = JSON.parse(jsonText);
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      console.error('Full response text:', responseText);
      console.error('\nAttempted to parse:', jsonText.substring(0, 1000));
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
    const newQuestions = parsedResponse.questions.map((q: any, idx: number) => ({
      ...q,
      id: `${unitId}_${topic.replace(/\s+/g, '_')}_${difficulty}_q${idx + 1}`,
      unitId,
      topic,
      difficulty,
    }));

    console.log(`✅ Generated ${newQuestions.length} questions`);

    // Remove old questions for this topic/difficulty
    const filteredQuestions = existingQuestions.filter((q: any) =>
      !(q.topic === topic && q.difficulty === difficulty)
    );

    // Add new questions
    const updatedQuestions = [...filteredQuestions, ...newQuestions];

    // Save back to file
    fs.writeFileSync(unitFilePath, JSON.stringify(updatedQuestions, null, 2));

    console.log(`\n💾 Updated ${unitFilePath}`);
    console.log(`   Removed: ${existingQuestions.length - filteredQuestions.length} old questions`);
    console.log(`   Added: ${newQuestions.length} new questions`);
    console.log(`   Total: ${updatedQuestions.length} questions in file\n`);

  } catch (error) {
    console.error('❌ Error generating questions:', error);
    process.exit(1);
  }
}

regenerateTopic().catch(console.error);
