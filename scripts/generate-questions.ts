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

/**
 * Check if a question is a meta-question about learning philosophy or teacher information
 */
function isMetaQuestion(question: Question): boolean {
  const questionText = question.question.toLowerCase();
  const explanationText = (question.explanation || '').toLowerCase();
  const combinedText = `${questionText} ${explanationText}`;

  // Patterns that indicate meta-questions
  const metaPatterns = [
    /making mistakes.*(discourage|should|part of learning|important|essential)/i,
    /language acquisition/i,
    /growth mindset/i,
    /willingness to learn/i,
    /learning process/i,
    /most important factor.*success/i,
    /effort.*language.*success/i,
    /learning.*language.*success/i,
    /learning.*emphasized/i,
    /practice.*key.*success/i,
    /consistency.*key/i,
    /mr\.\s*/i,
    /mrs\.\s*/i,
    /m\.\s*/i,
    /monsieur /i,
    /teacher.*lived/i,
    /teacher.*speaks.*languages/i,
    /teacher.*interests/i,
    /teacher.*hobbies/i,
    /teacher.*books/i,
    /four key skills/i,
    /course structure/i,
    /class structure/i,
    /mentioned in (the )?(vocabulary|materials|list)/i,
    /provided (vocabulary|materials)/i,
    /(listed|included) in the/i,
    /not.*mentioned/i,
    /which.*not.*(classroom object|vocabulary item)/i,
  ];

  return metaPatterns.some(pattern => pattern.test(combinedText));
}

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

❌ ABSOLUTELY FORBIDDEN - DO NOT create questions about:

**Meta-Questions About Learning:**
- "Making mistakes" in learning (whether it's good, bad, encouraged, discouraged, etc.)
- "Language acquisition" principles or theories
- "Growth mindset" or learning mindset concepts
- "Willingness to learn" or motivation concepts
- "Most important factor for success" in language learning
- "Effort and success" relationships in learning
- "Consistency is key" or similar learning philosophy
- "Practice makes perfect" or similar learning maxims
- How to study, learning strategies, or study techniques
- Whether something is "part of the learning process"

**Teacher/Course Administration:**
- "Monsieur " or "M. " or any specific teacher name
- Teacher's personal life, hobbies, background, or interests
- How long the teacher lived anywhere or what the teacher likes
- Teacher's books, accomplishments, or personal achievements
- "four key skills" or "key skills" curriculum structure
- Course structure, class structure, or curriculum design
- Classroom technology rules (Chromebooks, computers, phones, tablets)
- Daily materials or supplies needed for class (journals, pencils, notebooks)
- Grading policies, homework policies, or assessment methods
- Activities that will happen in class (role plays, potlucks, events)
- Classroom behavior policies or rules
- What the class/course includes or excludes

❌ If you see any of the above topics in the learning materials:
- DO NOT create questions about them
- SKIP that content entirely
- IGNORE all meta-information about learning, teaching, or the course itself

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
    },
    {
      "id": "q2",
      "question": "Je _____ français.",
      "type": "fill-in-blank",
      "correctAnswer": "parle",
      "explanation": "English explanation here"
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

Return ONLY the JSON, no additional text.`,
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

    // Try to extract JSON more robustly
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
      console.error('Attempted to parse:', jsonText.substring(0, 500) + '...');
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
    const questions: Question[] = parsedResponse.questions.map((q: any, idx: number) => ({
      ...q,
      id: `${unitId}_${topic.replace(/\s+/g, '_')}_${difficulty}_q${idx + 1}`,
      unitId,
      topic,
      difficulty,
    }));

    // Filter out any meta-questions that slipped through
    const validQuestions = questions.filter(q => !isMetaQuestion(q));

    if (validQuestions.length < questions.length) {
      console.log(`    ⚠️  Filtered out ${questions.length - validQuestions.length} meta-question(s)`);
    }

    return validQuestions;
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
