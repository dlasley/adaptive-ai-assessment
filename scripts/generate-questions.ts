/**
 * Script to pre-generate all assessment questions
 *
 * Run with: npm run generate-questions
 *
 * CLI Options:
 *   --unit <unit-id>        Generate for specific unit only (e.g., --unit unit-3)
 *   --topic <topic-name>    Generate for specific topic only
 *   --difficulty <level>    Generate for specific difficulty (beginner|intermediate|advanced)
 *   --count <n>             Questions per topic/difficulty (default: 10)
 *   --sync-db               Sync to database (with deduplication)
 *   --dry-run               Show what would be generated without actually generating
 *   --batch-id <id>         Custom batch ID (default: auto-generated from date)
 *   --source-file <path>    Source learning material file path for tracking
 *
 * Examples:
 *   npx tsx scripts/generate-questions.ts --unit unit-3 --sync-db
 *   npx tsx scripts/generate-questions.ts --unit unit-3 --topic "Numbers 0-20" --difficulty beginner
 *   npx tsx scripts/generate-questions.ts --unit unit-2 --count 25   # More questions for broad topics
 *   npx tsx scripts/generate-questions.ts --sync-db --dry-run
 */

import { config } from 'dotenv';
// Load environment variables from .env.local BEFORE other imports
config({ path: '.env.local' });

import Anthropic from '@anthropic-ai/sdk';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { units } from '../src/lib/units';
import { loadUnitMaterials, extractTopicContent } from '../src/lib/learning-materials';
import { inferWritingType, WritingType } from './lib/writing-type-inference';
import { MODELS } from './lib/config';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface Question {
  id: string;
  question: string;
  type: 'multiple-choice' | 'fill-in-blank' | 'true-false' | 'writing';
  options?: string[];
  correctAnswer: string;
  explanation?: string;
  unitId: string;
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  contentHash?: string;
  batchId?: string;
  sourceFile?: string;
}

interface CLIOptions {
  unitId?: string;
  topic?: string;
  difficulty?: 'beginner' | 'intermediate' | 'advanced';
  questionType?: 'multiple-choice' | 'fill-in-blank' | 'true-false' | 'writing';
  writingType?: WritingType;
  count: number;
  syncDb: boolean;
  dryRun: boolean;
  batchId: string;
  sourceFile?: string;
}

const DIFFICULTIES: ('beginner' | 'intermediate' | 'advanced')[] = ['beginner', 'intermediate', 'advanced'];
const QUESTIONS_PER_TOPIC_PER_DIFFICULTY = 10;

/**
 * Parse command line arguments
 */
function parseArgs(): CLIOptions {
  const args = process.argv.slice(2);
  const options: CLIOptions = {
    count: QUESTIONS_PER_TOPIC_PER_DIFFICULTY,
    syncDb: false,
    dryRun: false,
    batchId: `batch_${new Date().toISOString().split('T')[0]}_${Date.now()}`,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--unit':
        options.unitId = args[++i];
        break;
      case '--topic':
        options.topic = args[++i];
        break;
      case '--difficulty':
        options.difficulty = args[++i] as CLIOptions['difficulty'];
        break;
      case '--type':
        const typeVal = args[++i];
        if (!['multiple-choice', 'fill-in-blank', 'true-false', 'writing'].includes(typeVal)) {
          console.error('❌ --type must be one of: multiple-choice, fill-in-blank, true-false, writing');
          process.exit(1);
        }
        options.questionType = typeVal as CLIOptions['questionType'];
        break;
      case '--writing-type':
        const wtVal = args[++i];
        const validWritingTypes = ['translation', 'conjugation', 'question_formation', 'sentence_building', 'open_ended'];
        if (!validWritingTypes.includes(wtVal)) {
          console.error(`❌ --writing-type must be one of: ${validWritingTypes.join(', ')}`);
          process.exit(1);
        }
        options.writingType = wtVal as WritingType;
        break;
      case '--count':
        const countVal = parseInt(args[++i], 10);
        if (isNaN(countVal) || countVal < 1) {
          console.error('❌ --count must be a positive integer');
          process.exit(1);
        }
        options.count = countVal;
        break;
      case '--sync-db':
        options.syncDb = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--batch-id':
        options.batchId = args[++i];
        break;
      case '--source-file':
        options.sourceFile = args[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  // Validate --writing-type requires --type writing
  if (options.writingType && options.questionType !== 'writing') {
    console.error('❌ --writing-type requires --type writing');
    process.exit(1);
  }

  return options;
}

function printHelp(): void {
  console.log(`
Question Generation Script

Usage: npx tsx scripts/generate-questions.ts [options]

Options:
  --unit <unit-id>        Generate for specific unit only (e.g., --unit unit-3)
  --topic <topic-name>    Generate for specific topic only
  --difficulty <level>    Generate for specific difficulty (beginner|intermediate|advanced)
  --type <question-type>  Generate only this type (multiple-choice|fill-in-blank|true-false|writing)
  --writing-type <wtype>  Writing subtype (translation|conjugation|question_formation|sentence_building|open_ended)
  --count <n>             Questions per topic/difficulty (default: ${QUESTIONS_PER_TOPIC_PER_DIFFICULTY})
  --sync-db               Sync to database (with deduplication)
  --dry-run               Show what would be generated without actually generating
  --batch-id <id>         Custom batch ID (default: auto-generated)
  --source-file <path>    Source learning material file path for tracking
  --help, -h              Show this help message

Examples:
  npx tsx scripts/generate-questions.ts --unit unit-3 --sync-db
  npx tsx scripts/generate-questions.ts --unit unit-3 --topic "Numbers 0-20"
  npx tsx scripts/generate-questions.ts --unit unit-2 --count 25   # More questions for broad topics
  npx tsx scripts/generate-questions.ts --type writing --sync-db   # Add only writing questions
  npx tsx scripts/generate-questions.ts --type writing --writing-type conjugation --sync-db
  npx tsx scripts/generate-questions.ts --sync-db --dry-run
  `);
}

/**
 * Compute content hash for deduplication
 * Hash includes: question text, correct answer, topic, and difficulty
 * This allows the same question to exist at different difficulties
 */
function computeContentHash(
  questionText: string,
  correctAnswer: string,
  topic: string,
  difficulty: string
): string {
  const normalized = `${questionText}|${correctAnswer}|${topic}|${difficulty}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('md5').update(normalized).digest('hex');
}

/**
 * Initialize Supabase client for database operations
 */
function initSupabase(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Use secret key (bypasses RLS) for script operations, fall back to anon key
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('⚠️  Supabase credentials not found in environment');
    return null;
  }

  if (!process.env.SUPABASE_SECRET_KEY) {
    console.log('⚠️  SUPABASE_SECRET_KEY not set — using anon key (may fail with RLS restrictions)');
  }

  return createClient(supabaseUrl, supabaseKey);
}

/**
 * Fetch existing content hashes from database for deduplication
 * Fetches ALL hashes to ensure cross-topic deduplication works correctly
 */
async function fetchExistingHashes(
  supabase: SupabaseClient
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('questions')
    .select('content_hash')
    .not('content_hash', 'is', null);

  if (error) {
    console.error('Error fetching existing hashes:', error);
    return new Set();
  }

  return new Set(data?.map(row => row.content_hash) || []);
}

/**
 * Insert new questions to database (skipping duplicates)
 */
async function syncToDatabase(
  supabase: SupabaseClient,
  questions: Question[],
  existingHashes: Set<string>,
  batchId: string,
  sourceFile?: string
): Promise<{ inserted: number; skipped: number }> {
  const newQuestions = questions.filter(q => q.contentHash && !existingHashes.has(q.contentHash));
  const skipped = questions.length - newQuestions.length;

  if (newQuestions.length === 0) {
    return { inserted: 0, skipped };
  }

  // Convert to database format (unified questions table)
  const dbRecords = newQuestions.map(q => {
    const qType = q.type as string;
    const isChoiceType = qType === 'multiple-choice' || qType === 'true-false';
    const isTypedType = qType === 'fill-in-blank' || qType === 'writing';
    const isWriting = qType === 'writing';

    return {
      question: q.question,
      correct_answer: q.correctAnswer,
      unit_id: q.unitId,
      topic: q.topic,
      difficulty: q.difficulty,
      type: q.type,
      options: isChoiceType ? q.options : null,
      acceptable_variations: isTypedType ? (q.options || []) : [],
      writing_type: isWriting ? inferWritingType(q.question) : null,
      explanation: q.explanation,
      hints: [],
      requires_complete_sentence: false,
      content_hash: q.contentHash,
      batch_id: batchId,
      source_file: sourceFile,
    };
  });

  const { error } = await supabase
    .from('questions')
    .insert(dbRecords);

  if (error) {
    console.error('Error inserting questions:', error);
    return { inserted: 0, skipped };
  }

  return { inserted: newQuestions.length, skipped };
}

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
  numQuestions: number,
  questionType?: 'multiple-choice' | 'fill-in-blank' | 'true-false' | 'writing',
  writingType?: WritingType
): Promise<Question[]> {
  const typeLabel = questionType ? ` ${questionType}` : '';
  const subtypeLabel = writingType ? ` (${writingType})` : '';
  console.log(`  Generating ${numQuestions} ${difficulty}${typeLabel}${subtypeLabel} questions for: ${topic}`);

  try {
    const unitMaterials = loadUnitMaterials(unitId);
    const topicContent = extractTopicContent(unitMaterials, topic);

    const message = await anthropic.messages.create({
      model: MODELS.questionGeneration,
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
2. ${questionType ? `Create ONLY "${questionType}" type questions` : 'Mix question types: multiple-choice, fill-in-blank, true-false, writing'}
3. Make questions appropriate for ${difficulty} level students
4. Include clear, unambiguous correct answers
5. Add brief explanations for the correct answers IN ENGLISH (NOT in French)
6. NEVER include the answer (or a substantial part of it) in the question text:
   - Do NOT put the French answer in parentheses as a hint (e.g., "(Use the phrase 'Il est quel jour?')")
   - Do NOT use "Use the structure: '[answer]'" where the structure IS the expected answer
   - For transformation/combination questions, the correct answer must require meaningful work beyond trivially prepending a word or adding punctuation
   - If the question quotes French text, the correct answer must NOT be that same text with minor additions
7. Return ONLY valid JSON matching this exact format:

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
    },
    {
      "id": "q3",
      "question": "Translate to French: 'We speak French.'",
      "type": "writing",
      "correctAnswer": "Nous parlons français.",
      "explanation": "Uses 'nous' form of parler (parlons) with the language"
    }
  ]
}

${questionType ? `Question type: "${questionType}" ONLY - do not create any other type` : 'Question type options: "multiple-choice", "fill-in-blank", "true-false", "writing"'}

For fill-in-blank questions:
- Use underscores like: "Je _____ français." (I speak French)
- correctAnswer should be the word(s) to fill in
- No options array needed
- Explanation must be in English

For true-false questions:
- options should be ["Vrai", "Faux"]
- correctAnswer should be "Vrai" or "Faux"

For writing questions:
- These are longer-form responses requiring full sentences or translations
- correctAnswer should be the expected response (accept reasonable variations)
- No options array needed
${writingType ? `
IMPORTANT: Create ONLY "${writingType}" type writing questions:
${writingType === 'translation' ? `- Translation: "Translate to French: '...'"
- Example: "Translate to French: 'I like to eat apples.'" → "J'aime manger des pommes."
- All answers must be in French` : ''}
${writingType === 'conjugation' ? `- Conjugation: Ask students to conjugate verbs in specific forms
- Example: "Conjugate the verb 'parler' in the present tense for all six subject pronouns."
- Example: "Write the 'nous' form of 'danser' in a complete sentence."` : ''}
${writingType === 'question_formation' ? `- Question Formation: Ask students to form questions using French structures
- Example: "Write a question asking your friend what they like to do, using 'est-ce que'."
- Example: "Create a question using inversion to ask 'Do you speak French?'"` : ''}
${writingType === 'sentence_building' ? `- Sentence Building: Ask students to construct sentences using given elements
- Example: "Write a sentence using the words: je, aimer, danser"
- Example: "Combine these two sentences using 'qui': 'J'ai un ami. L'ami parle français.'"` : ''}
${writingType === 'open_ended' ? `- Open-ended: Creative writing, dialogues, descriptions
- Example: "Write a short dialogue between two people meeting for the first time."
- Example: "Describe your classroom in 3-4 sentences using classroom vocabulary."` : ''}
` : `- Good for: translations, sentence construction, conjugation in context`}

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
    let validQuestions = questions.filter(q => !isMetaQuestion(q));

    if (validQuestions.length < questions.length) {
      console.log(`    ⚠️  Filtered out ${questions.length - validQuestions.length} meta-question(s)`);
    }

    // Enforce type constraint when --type flag is used (prevent AI type drift)
    if (questionType) {
      const beforeTypeFilter = validQuestions.length;
      validQuestions = validQuestions.filter(q => q.type === questionType);
      const typeDrift = beforeTypeFilter - validQuestions.length;
      if (typeDrift > 0) {
        console.log(`    ⚠️  Filtered out ${typeDrift} question(s) with wrong type (type drift)`);
      }
    }

    // Enforce writing type constraint when --writing-type flag is used
    if (writingType) {
      const beforeWritingFilter = validQuestions.length;
      validQuestions = validQuestions.filter(q => {
        const inferredType = inferWritingType(q.question);
        return inferredType === writingType;
      });
      const writingDrift = beforeWritingFilter - validQuestions.length;
      if (writingDrift > 0) {
        console.log(`    ⚠️  Filtered out ${writingDrift} question(s) with wrong writing type (writing type drift)`);
      }
    }

    return validQuestions;
  } catch (error) {
    console.error(`  ❌ Error generating questions for ${topic} (${difficulty}):`, error);
    return [];
  }
}

async function generateAllQuestions(options: CLIOptions) {
  console.log('🚀 Starting question generation...\n');
  console.log('Configuration:');
  console.log(`   Unit:        ${options.unitId || 'all'}`);
  console.log(`   Topic:       ${options.topic || 'all'}`);
  console.log(`   Difficulty:  ${options.difficulty || 'all'}`);
  console.log(`   Count:       ${options.count} per topic/difficulty`);
  console.log(`   Sync to DB:  ${options.syncDb ? 'yes' : 'no'}`);
  console.log(`   Dry run:     ${options.dryRun ? 'yes' : 'no'}`);
  console.log(`   Batch ID:    ${options.batchId}`);
  if (options.sourceFile) {
    console.log(`   Source file: ${options.sourceFile}`);
  }
  console.log();

  // Initialize Supabase if syncing to database
  let supabaseClient: ReturnType<typeof initSupabase> = null;
  let existingHashes = new Set<string>();

  if (options.syncDb) {
    supabaseClient = initSupabase();
    if (!supabaseClient) {
      console.error('❌ Cannot sync to DB: Supabase not configured');
      console.log('   Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local');
      process.exit(1);
    }
    console.log('📡 Fetching existing content hashes for deduplication...');
    existingHashes = await fetchExistingHashes(supabaseClient);
    console.log(`   Found ${existingHashes.size} existing question hashes\n`);
  }

  const allQuestions: Question[] = [];
  let totalGenerated = 0;
  let totalAttempted = 0;
  let totalSkippedDuplicates = 0;
  let totalInserted = 0;

  // Filter units based on CLI options
  const unitsToProcess = options.unitId
    ? units.filter(u => u.id === options.unitId)
    : units;

  if (unitsToProcess.length === 0) {
    console.error(`❌ Unit not found: ${options.unitId}`);
    console.log('   Available units:', units.map(u => u.id).join(', '));
    process.exit(1);
  }

  for (const unit of unitsToProcess) {
    console.log(`\n📚 Processing ${unit.title}...`);

    // Filter topics based on CLI options
    const topicNames = unit.topics.map(t => t.name);
    const topicsToProcess = options.topic
      ? topicNames.filter(t => t === options.topic || t.toLowerCase().includes(options.topic!.toLowerCase()))
      : topicNames;

    if (options.topic && topicsToProcess.length === 0) {
      console.log(`   ⚠️  Topic "${options.topic}" not found in this unit`);
      continue;
    }

    for (const topic of topicsToProcess) {
      // Filter difficulties based on CLI options
      const difficultiesToProcess = options.difficulty
        ? [options.difficulty]
        : DIFFICULTIES;

      for (const difficulty of difficultiesToProcess) {
        totalAttempted++;

        if (options.dryRun) {
          const typeLabel = options.questionType ? ` ${options.questionType}` : '';
          console.log(`  [DRY RUN] Would generate ${options.count} ${difficulty}${typeLabel} questions for: ${topic}`);
          continue;
        }

        const questions = await generateQuestionsForTopic(
          unit.id,
          topic,
          difficulty,
          options.count,
          options.questionType,
          options.writingType
        );

        if (questions.length > 0) {
          // Add content hashes and batch metadata to each question
          const questionsWithHashes = questions.map(q => ({
            ...q,
            contentHash: computeContentHash(q.question, q.correctAnswer, q.topic, q.difficulty),
            batchId: options.batchId,
            sourceFile: options.sourceFile,
          }));

          allQuestions.push(...questionsWithHashes);
          totalGenerated += questionsWithHashes.length;

          // Sync to database if enabled
          if (options.syncDb && supabaseClient) {
            const { inserted, skipped } = await syncToDatabase(
              supabaseClient,
              questionsWithHashes,
              existingHashes,
              options.batchId,
              options.sourceFile
            );
            totalInserted += inserted;
            totalSkippedDuplicates += skipped;

            // Add newly inserted hashes to the set to avoid duplicates within the same run
            for (const q of questionsWithHashes) {
              if (q.contentHash) existingHashes.add(q.contentHash);
            }

            if (inserted > 0 || skipped > 0) {
              console.log(`    ✅ Generated ${questions.length} | Inserted ${inserted} | Skipped ${skipped} duplicates`);
            } else {
              console.log(`    ✅ Generated ${questions.length} questions`);
            }
          } else {
            console.log(`    ✅ Generated ${questions.length} questions`);
          }
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  if (options.dryRun) {
    const estimatedQuestions = totalAttempted * options.count;
    console.log('\n\n📋 DRY RUN Summary:');
    console.log(`   Would process: ${totalAttempted} topic/difficulty combinations`);
    console.log(`   Estimated questions: ~${estimatedQuestions}`);
    return;
  }

  console.log('\n\n✅ Question generation complete!');
  console.log(`📊 Statistics:`);
  console.log(`   Topics processed:     ${totalAttempted}`);
  console.log(`   Questions generated:  ${totalGenerated}`);

  if (options.syncDb) {
    console.log(`   Inserted to DB:       ${totalInserted}`);
    console.log(`   Skipped (duplicates): ${totalSkippedDuplicates}`);

    // Calculate and display collision rate with quality guidance
    if (totalGenerated > 0) {
      const collisionRate = (totalSkippedDuplicates / totalGenerated) * 100;
      console.log(`   Collision rate:       ${collisionRate.toFixed(1)}%`);

      if (collisionRate >= 80) {
        console.log('\n⚠️  WARNING: Very high collision rate (≥80%)');
        console.log('   The topic/difficulty combination appears saturated.');
        console.log('   Further generation is likely to produce diminishing returns');
        console.log('   or lower-quality questions. Consider:');
        console.log('   • Stopping generation for this topic/difficulty');
        console.log('   • Adding new learning materials to expand the topic');
        console.log('   • Reviewing existing questions for quality');
      } else if (collisionRate >= 50) {
        console.log('\n⚠️  NOTICE: Moderate collision rate (≥50%)');
        console.log('   Many questions already exist for this topic/difficulty.');
        console.log('   Quality may begin to degrade with additional generation.');
        console.log('   Consider reviewing the newest questions for repetitiveness.');
      } else if (collisionRate >= 30) {
        console.log('\n📝 Note: Some collisions detected (≥30%)');
        console.log('   The question pool is filling up. This is normal.');
      }
    }
  } else {
    console.log('\n⚠️  Questions were generated but NOT saved to database.');
    console.log('   Use --sync-db flag to persist questions to Supabase.');
  }
}

// Parse CLI args and run the generation
const options = parseArgs();
generateAllQuestions(options).catch(console.error);
