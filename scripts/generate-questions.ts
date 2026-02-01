/**
 * Script to pre-generate all assessment questions
 * Run with: npm run generate-questions
 */

import { config } from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

// Load environment variables from .env.local
config({ path: '.env.local' });
import fs from 'fs';
import path from 'path';
import { units } from '../src/lib/units';
import { loadUnitMaterials, extractTopicContent } from '../src/lib/learning-materials';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface Question {
  id: string;
  question: string;
  type: 'multiple-choice' | 'fill-in-blank' | 'true-false';
  options?: string[];
  correctAnswer: string;
  explanation?: string;
  unitId: string;
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}

const DIFFICULTIES: ('beginner' | 'intermediate' | 'advanced')[] = ['beginner', 'intermediate', 'advanced'];
const QUESTIONS_PER_TOPIC_PER_DIFFICULTY = 10;

async function generateQuestionsForTopic(
  unitId: string,
  topic: string,
  difficulty: 'beginner' | 'intermediate' | 'advanced',
  numQuestions: number
): Promise<Question[]> {
  console.log(`  Generating ${numQuestions} ${difficulty} questions for: ${topic}`);

  try {
    const unitMaterials = loadUnitMaterials(unitId);
    const topicContent = extractTopicContent(unitMaterials, topic);

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // Latest Haiku 4.5 - fastest and most cost-effective
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `You are a French language teacher creating practice questions for students.

Based on the following learning materials about "${topic}", create ${numQuestions} practice questions at a ${difficulty} level.

Learning Materials:
${topicContent}

CRITICAL: ONLY CREATE QUESTIONS ABOUT FRENCH LANGUAGE LEARNING

❌ ABSOLUTELY FORBIDDEN - DO NOT create questions that mention:
- "Monsieur " or "M. " - NEVER use this name in any question
- "four key skills" or "key skills" - NEVER mention these phrases
- "course structure" or "class structure"
- Any teacher names or teacher personal information
- Classroom technology rules (Chromebooks, computers, phones, tablets)
- Daily materials or supplies needed for class (journals, pencils, notebooks for class)
- Grading policies, homework policies, or assessment methods
- Activities that will happen in class (role plays, potlucks, end-of-semester events)
- "NOT one of" followed by course/curriculum elements
- Classroom behavior policies or rules
- Questions asking about what the class/course includes or excludes
- Teacher's personal life, hobbies, or background
- How long the teacher lived anywhere or what the teacher likes

❌ If you see "Monsieur " or references to "four key skills" in the learning materials:
- DO NOT create questions about it
- SKIP that content entirely
- IGNORE teacher-specific information

✅ ONLY create questions testing knowledge of:
- French vocabulary: nouns, verbs, adjectives, common expressions
- French grammar: verb conjugations, articles, pronouns, sentence structure
- French language usage: formal vs informal, proper usage contexts
- French culture: geography, traditions, customs, francophone world
- Practical communication: greetings, conversations, asking questions in French
- Reading and writing in French
- Translation between French and English

If the learning materials contain administrative or course-related content, IGNORE IT COMPLETELY and only generate questions from the actual French language content.

IMPORTANT INSTRUCTIONS:
1. Create EXACTLY ${numQuestions} questions
2. Mix question types: multiple-choice, fill-in-blank, true-false
3. Make questions appropriate for ${difficulty} level students
4. Include clear, unambiguous correct answers
5. Add brief explanations for the correct answers
6. Return ONLY valid JSON matching this exact format:

{
  "questions": [
    {
      "id": "q1",
      "question": "Question text here?",
      "type": "multiple-choice",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option B",
      "explanation": "Brief explanation of why this is correct"
    }
  ]
}

Question type options: "multiple-choice", "fill-in-blank", "true-false"

For fill-in-blank questions:
- Use underscores like: "Je _____ français." (I speak French)
- correctAnswer should be just the word to fill in
- No options array needed

For true-false questions:
- options should be ["Vrai", "Faux"]
- correctAnswer should be "Vrai" or "Faux"

Return ONLY the JSON, no additional text.`,
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      throw new Error('No valid JSON found in response');
    }

    const parsedResponse = JSON.parse(jsonMatch[0]);
    const questions: Question[] = parsedResponse.questions.map((q: any, idx: number) => ({
      ...q,
      id: `${unitId}_${topic.replace(/\s+/g, '_')}_${difficulty}_q${idx + 1}`,
      unitId,
      topic,
      difficulty,
    }));

    return questions;
  } catch (error) {
    console.error(`  ❌ Error generating questions for ${topic} (${difficulty}):`, error);
    return [];
  }
}

async function generateAllQuestions() {
  console.log('🚀 Starting question generation...\n');

  const allQuestions: Question[] = [];
  let totalGenerated = 0;
  let totalAttempted = 0;

  for (const unit of units) {
    console.log(`\n📚 Processing ${unit.title}...`);

    for (const topic of unit.topics) {
      for (const difficulty of DIFFICULTIES) {
        totalAttempted++;

        const questions = await generateQuestionsForTopic(
          unit.id,
          topic,
          difficulty,
          QUESTIONS_PER_TOPIC_PER_DIFFICULTY
        );

        if (questions.length > 0) {
          allQuestions.push(...questions);
          totalGenerated += questions.length;
          console.log(`    ✅ Generated ${questions.length} questions`);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // Save all questions to a single JSON file
  const outputDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'questions.json');
  fs.writeFileSync(outputPath, JSON.stringify(allQuestions, null, 2));

  // Also save organized by unit for easier access
  for (const unit of units) {
    const unitQuestions = allQuestions.filter(q => q.unitId === unit.id);
    const unitPath = path.join(outputDir, `questions-${unit.id}.json`);
    fs.writeFileSync(unitPath, JSON.stringify(unitQuestions, null, 2));
  }

  console.log('\n\n✅ Question generation complete!');
  console.log(`📊 Statistics:`);
  console.log(`   Total topics processed: ${totalAttempted / 3} topics`);
  console.log(`   Total questions attempted: ${totalAttempted * QUESTIONS_PER_TOPIC_PER_DIFFICULTY}`);
  console.log(`   Total questions generated: ${totalGenerated}`);
  console.log(`   Success rate: ${Math.round((totalGenerated / (totalAttempted * QUESTIONS_PER_TOPIC_PER_DIFFICULTY)) * 100)}%`);
  console.log(`\n📁 Saved to:`);
  console.log(`   ${outputPath}`);
  console.log(`   ${path.join(outputDir, 'questions-*.json')}`);
}

// Run the generation
generateAllQuestions().catch(console.error);
