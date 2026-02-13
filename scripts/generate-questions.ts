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
 *   --write-db              Sync to database (with deduplication)
 *   --sync-db               (deprecated alias for --write-db)
 *   --dry-run               Show what would be generated without actually generating
 *   --batch-id <id>         Custom batch ID (default: auto-generated from date)
 *   --source-file <path>    Source learning material file path for tracking
 *   --model <model-id>      Override generation model for ALL types (disables hybrid mode)
 *   --skip-validation       Skip answer validation pass (faster, no variation generation)
 *
 * Hybrid Model Generation:
 *   By default, uses Haiku for MCQ/T-F and Sonnet for fill-in-blank/writing.
 *   --model overrides this and uses a single model for all types.
 *   --type auto-selects the appropriate model for that type.
 *
 * Examples:
 *   npx tsx scripts/generate-questions.ts --unit unit-3 --write-db          # Hybrid mode
 *   npx tsx scripts/generate-questions.ts --unit unit-3 --type writing      # Sonnet only
 *   npx tsx scripts/generate-questions.ts --unit unit-3 --model claude-haiku-4-5-20251001  # Force Haiku
 *   npx tsx scripts/generate-questions.ts --write-db --dry-run
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
import { MODELS, STRUCTURED_TYPES, TYPED_TYPES, getModelForType, QuestionType } from './lib/config';

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
  acceptableVariations?: string[];
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
  // Override: uses a single model for all types (disables hybrid mode)
  model?: string;
  skipValidation?: boolean;
}

const DIFFICULTIES: ('beginner' | 'intermediate' | 'advanced')[] = ['beginner', 'intermediate', 'advanced'];
const QUESTIONS_PER_TOPIC_PER_DIFFICULTY = 10;

// Exemplar pool for difficulty calibration — rotated per topic to reduce homogeneity
interface Exemplar { type: string; question: string; answer: string }
const EXEMPLAR_POOL: Record<string, Exemplar[]> = {
  beginner: [
    { type: 'fill-in-blank', question: 'Conjugate être for the subject \'vous\': _____', answer: 'êtes' },
    { type: 'fill-in-blank', question: 'Marie regarde le menu au restaurant. Elle _____.', answer: 'a faim' },
    { type: 'writing', question: 'Conjugate the verb \'danser\' (to dance) in the present tense for the subject pronoun \'je\'.', answer: 'je danse' },
    { type: 'writing', question: 'Translate to French: \'Hello, my name is Paul.\'', answer: 'Bonjour, je m\'appelle Paul.' },
    { type: 'multiple-choice', question: 'What does \'bonjour\' mean?', answer: 'Hello' },
  ],
  intermediate: [
    { type: 'fill-in-blank', question: 'Nous ______ une comédie avec nos amis.', answer: 'voyons' },
    { type: 'fill-in-blank', question: 'Tu _____ le football et il _____ le tennis.', answer: 'aimes préfère' },
    { type: 'writing', question: 'Conjugate the verb \'jouer\' for \'je\' in a complete sentence about playing soccer.', answer: 'Je joue au foot.' },
    { type: 'writing', question: 'Translate to French: \'We don\'t like swimming.\'', answer: 'Nous n\'aimons pas nager.' },
    { type: 'multiple-choice', question: 'Choose the correct sentence: "Je suis faim" / "J\'ai faim" / "Je fais faim" / "Je mange faim"', answer: 'J\'ai faim' },
  ],
  advanced: [
    { type: 'fill-in-blank', question: 'Nous _____ soif et nous _____ une boisson froide.', answer: 'avons buvons' },
    { type: 'fill-in-blank', question: 'Le français est une langue officielle _____ 29 pays et le Sénégal est _____ ces pays.', answer: 'dans parmi' },
    { type: 'writing', question: 'Write three sentences using different subject pronouns (tu, on, elles) with \'aimer\' or \'préférer\' conjugated correctly, each including an intensity adverb.', answer: 'Tu aimes un peu danser. On préfère bien la musique. Elles aiment beaucoup les blogs.' },
    { type: 'writing', question: 'Write two sentences ordering at a café: one using a partitive article and one using negation.', answer: 'Je voudrais du café et un croissant. Je ne veux pas de thé.' },
    { type: 'multiple-choice', question: 'Questions requiring knowledge of two grammar rules to identify the correct answer', answer: '(combined concepts)' },
  ],
};

/**
 * Select 3 exemplars per difficulty level, rotated deterministically by topic name.
 */
function selectExemplars(topic: string): Record<string, Exemplar[]> {
  // djb2 hash for better distribution across pool indices
  let hash = 5381;
  for (let i = 0; i < topic.length; i++) {
    hash = ((hash << 5) + hash + topic.charCodeAt(i)) >>> 0;
  }

  const selected: Record<string, Exemplar[]> = {};
  for (const diff of DIFFICULTIES) {
    const pool = EXEMPLAR_POOL[diff];
    const start = hash % pool.length;
    selected[diff] = [];
    for (let i = 0; i < 3; i++) {
      selected[diff].push(pool[(start + i) % pool.length]);
    }
  }
  return selected;
}

function formatExemplars(exemplars: Record<string, Exemplar[]>): string {
  const lines: string[] = [];
  const labels: Record<string, string> = {
    beginner: 'BEGINNER examples (single concept, direct recall)',
    intermediate: 'INTERMEDIATE examples (apply rules in context, short sentences)',
    advanced: 'ADVANCED examples (combine multiple concepts, multi-step production)',
  };
  for (const diff of DIFFICULTIES) {
    lines.push(`${labels[diff]}:`);
    for (const ex of exemplars[diff]) {
      lines.push(`  ${ex.type}: "${ex.question}" → "${ex.answer}"`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

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
      case '--write-db':
        options.syncDb = true;
        break;
      case '--sync-db':
        console.warn('⚠️  --sync-db is deprecated, use --write-db instead');
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
      case '--model':
        options.model = args[++i];
        break;
      case '--skip-validation':
        options.skipValidation = true;
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
  --write-db              Sync to database (with deduplication)
  --sync-db               (deprecated alias for --write-db)
  --dry-run               Show what would be generated without actually generating
  --batch-id <id>         Custom batch ID (default: auto-generated)
  --source-file <path>    Source learning material file path for tracking
  --model <model-id>      Override model for ALL types (disables hybrid mode)
  --skip-validation       Skip answer validation (faster, no variation generation)
  --help, -h              Show this help message

Hybrid Model Generation:
  By default, uses Haiku for MCQ/T-F and Sonnet for fill-in-blank/writing.
  --model overrides this and uses a single model for all types.
  --type auto-selects the appropriate model for that type.

Examples:
  npx tsx scripts/generate-questions.ts --unit unit-3 --write-db          # Hybrid mode
  npx tsx scripts/generate-questions.ts --unit unit-3 --type writing      # Sonnet auto-selected
  npx tsx scripts/generate-questions.ts --model claude-haiku-4-5-20251001 # Force single model
  npx tsx scripts/generate-questions.ts --type writing --writing-type conjugation --write-db
  npx tsx scripts/generate-questions.ts --write-db --dry-run
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
  generatedBy: string,
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
      acceptable_variations: isTypedType ? (q.acceptableVariations || []) : [],
      writing_type: isWriting ? inferWritingType(q.question) : null,
      explanation: q.explanation,
      hints: [],
      requires_complete_sentence: false,
      content_hash: q.contentHash,
      batch_id: batchId,
      source_file: sourceFile,
      generated_by: generatedBy,
      quality_status: 'pending',
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

/**
 * Structural validation — fast checks that reject obviously malformed questions (no API call).
 */
function structuralValidation(questions: Question[]): { valid: Question[]; rejected: { question: Question; reason: string }[] } {
  const valid: Question[] = [];
  const rejected: { question: Question; reason: string }[] = [];

  for (const q of questions) {
    switch (q.type) {
      case 'multiple-choice':
        if (!q.options || q.options.length !== 4) {
          rejected.push({ question: q, reason: 'MCQ must have exactly 4 options' });
        } else if (!q.options.includes(q.correctAnswer)) {
          rejected.push({ question: q, reason: 'MCQ correctAnswer not in options' });
        } else if (new Set(q.options).size !== q.options.length) {
          rejected.push({ question: q, reason: 'MCQ has duplicate options' });
        } else {
          valid.push(q);
        }
        break;
      case 'true-false':
        if (!q.options || !['Vrai', 'Faux'].every(o => q.options!.includes(o))) {
          rejected.push({ question: q, reason: 'T/F options must be ["Vrai", "Faux"]' });
        } else if (!['Vrai', 'Faux'].includes(q.correctAnswer)) {
          rejected.push({ question: q, reason: 'T/F correctAnswer must be Vrai or Faux' });
        } else {
          valid.push(q);
        }
        break;
      case 'fill-in-blank': {
        const blankCount = (q.question.match(/_{3,}/g) || []).length;
        // For multi-blank: count comma-separated groups instead of space-separated words
        const answerGroups = blankCount > 1
          ? q.correctAnswer.split(',').map(g => g.trim()).filter(Boolean)
          : [q.correctAnswer.trim()];
        if (!q.question.includes('_____')) {
          rejected.push({ question: q, reason: 'Fill-in-blank must contain _____' });
        } else if (q.correctAnswer.length < 1) {
          rejected.push({ question: q, reason: 'Fill-in-blank answer is empty' });
        } else if (blankCount > 1 && answerGroups.length !== blankCount) {
          rejected.push({ question: q, reason: `Fill-in-blank has ${blankCount} blanks but ${answerGroups.length} comma-separated answer groups` });
        } else {
          valid.push(q);
        }
        break;
      }
      case 'writing':
        if (q.correctAnswer.length < 5) {
          rejected.push({ question: q, reason: 'Writing answer too short (<5 chars)' });
        } else {
          valid.push(q);
        }
        break;
      default:
        valid.push(q);
    }
  }

  return { valid, rejected };
}

const VALIDATION_PROMPT = `You are a French language expert validating quiz questions for a French 1 (beginner) course.

For each question below, evaluate whether the provided correct answer is actually correct.

## French Grammar Reference — these are all CORRECT French

**Articles & Partitives**
- Definite articles for general preferences: "J'aime les pommes" (NOT "J'aime des pommes")
- Partitive after negation becomes "de": "Je ne mange pas de pommes" (NOT "pas des pommes")
- Mandatory contractions: à+le→au, à+les→aux, de+le→du, de+les→des
- No article after "en" for countries/continents: "en France" (NOT "en la France")

**Conjugation & Pronouns**
- "On" ALWAYS takes 3rd person singular: "on aime", "on mange" — even when meaning "we"
- Stressed pronouns after prepositions: "avec moi" (NOT "avec je"), "pour toi", "chez lui"
- Conjugation-only answers (without subject pronouns) are valid in fill-in-blank: "mangeons" for "nous _____"

**Elision**
- Before vowel sounds and mute h: j'aime, l'école, l'homme, n'aime, d'accord
- NOT before consonants: "la liberté" (NOT "l'liberté"), "le livre" (NOT "l'livre")
- "Le haricot" (aspirated h, no elision)

**Expressions**
- "avoir" for physical states: avoir faim, avoir soif, avoir chaud (NOT "être faim")
- "boire" for beverages: "boire du café" (NOT "manger du café")
- Days of the week NOT capitalized: "lundi", "mardi"

## Fill-in-blank Format
- Single blank: correctAnswer is the word(s) that fill the blank (can be multi-word, e.g., "n'aime pas")
- Multiple blanks: correctAnswer is comma-separated groups, one per blank, in order of appearance
- Example: "Tu _____ le foot et il _____ le tennis." → correctAnswer: "aimes, préfère"
- Example (negation): "Je _____ le foot et tu _____ le tennis." → correctAnswer: "n'aime pas, ne préfères pas"
- If blank count does not match comma-separated group count (for multi-blank), mark answer_valid: false
- When generating acceptable_variations for multi-blank fill-in-blank, maintain the same comma-separated format (one group per blank, same order)

## Instructions

For each question:
1. Check if the correct answer is genuinely correct for the question asked
2. Check if the French grammar is correct in both question and answer
3. For fill-in-blank with multiple blanks: verify the number of comma-separated answer groups matches the number of "_____" blanks
4. For fill-in-blank and writing questions that PASS: generate 2-3 acceptable alternative answers that a French teacher would also accept (different valid phrasings, word order variations, accent variants)
5. For multiple-choice and true-false questions: no variations needed

Respond with ONLY valid JSON (no markdown, no code fences):
{"results": [{"id": "q1", "answer_valid": true, "acceptable_variations": ["var1", "var2"], "notes": "OK"}, ...]}

Set answer_valid to false ONLY if the answer is factually wrong or has a grammar error. Do NOT reject questions just because multiple answers could work — that's expected for typed-answer questions.`;

interface ValidationResult {
  id: string;
  answer_valid: boolean;
  acceptable_variations: string[];
  notes: string;
}

/**
 * AI-powered answer validation + acceptable variation generation.
 * Batches questions in groups of ~5 for efficiency.
 * Returns only questions that pass validation, with acceptableVariations populated.
 */
async function validateAnswers(questions: Question[]): Promise<{ valid: Question[]; rejected: { question: Question; reason: string }[] }> {
  if (questions.length === 0) return { valid: [], rejected: [] };

  const BATCH_SIZE = 5;
  const allValid: Question[] = [];
  const allRejected: { question: Question; reason: string }[] = [];

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);

    const questionsText = batch.map((q, idx) => {
      const optionsText = q.options ? `\nOptions: ${q.options.join(' / ')}` : '';
      return `Question ${idx + 1} (${q.type}, ${q.difficulty}):
Q: ${q.question}${optionsText}
A: ${q.correctAnswer}`;
    }).join('\n\n');

    try {
      const message = await anthropic.messages.create({
        model: MODELS.answerValidation,
        max_tokens: 2000,
        messages: [
          { role: 'user', content: `${VALIDATION_PROMPT}\n\n---\n\n${questionsText}` },
        ],
      });

      const responseText = (message.content[0] as { type: 'text'; text: string }).text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`    ⚠️  Validation: parse error, passing batch through`);
        allValid.push(...batch);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0].replace(/,(\s*[}\]])/g, '$1'));
      const results: ValidationResult[] = parsed.results;

      for (let j = 0; j < batch.length; j++) {
        const q = batch[j];
        const result = results[j];

        if (!result) {
          allValid.push(q);
          continue;
        }

        if (result.answer_valid) {
          if ((q.type === 'fill-in-blank' || q.type === 'writing') && result.acceptable_variations?.length > 0) {
            q.acceptableVariations = result.acceptable_variations;
          }
          allValid.push(q);
        } else {
          allRejected.push({ question: q, reason: result.notes || 'Answer incorrect' });
        }
      }
    } catch (error) {
      console.log(`    ⚠️  Validation API error, passing batch through: ${error instanceof Error ? error.message : 'unknown'}`);
      allValid.push(...batch);
    }
  }

  return { valid: allValid, rejected: allRejected };
}

async function generateQuestionsForTopic(
  unitId: string,
  topic: string,
  difficulty: 'beginner' | 'intermediate' | 'advanced',
  numQuestions: number,
  questionType?: 'multiple-choice' | 'fill-in-blank' | 'true-false' | 'writing',
  writingType?: WritingType,
  modelOverride?: string,
  allowedTypes?: QuestionType[],
  skipValidation?: boolean
): Promise<Question[]> {
  const typeLabel = questionType ? ` ${questionType}` : allowedTypes ? ` [${allowedTypes.join('/')}]` : '';
  const subtypeLabel = writingType ? ` (${writingType})` : '';
  console.log(`  Generating ${numQuestions} ${difficulty}${typeLabel}${subtypeLabel} questions for: ${topic}`);

  try {
    const unitMaterials = loadUnitMaterials(unitId);
    const topicContent = extractTopicContent(unitMaterials, topic);

    const message = await anthropic.messages.create({
      model: modelOverride || MODELS.questionGenerationStructured,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `You are a French 1 teacher creating quiz questions about "${topic}".

## Scope
- Topic: ${topic}
- Difficulty: ${difficulty}
- This is a first-year French course (French 1)

## Reference Materials
These materials show what has been taught for this topic. Use them to understand scope and emphasis, but you may also draw on standard French 1 curriculum knowledge for this topic.

${topicContent}

## Difficulty Levels

**Beginner**: Recognition and recall
- Translate single words or very short phrases
- Identify correct translations from options
- Recall basic vocabulary (e.g., "What is 'cat' in French?")
- Simple true/false about word meanings
- Fill-in-blank with a single common word
- Writing: single sentence (translation or simple response)

**Intermediate**: Application in simple contexts
- Complete sentences requiring correct conjugation or article choice
- Translate short sentences (5-8 words)
- Choose the grammatically correct option from choices
- Apply rules in context (e.g., choose tu vs. vous for a scenario)
- Fill-in-blank requiring grammar knowledge (agreement, conjugation)
- Writing: 1-2 sentences (translation with grammar, short response)

**Advanced**: Synthesis and production
- Translate longer sentences combining multiple grammar concepts
- Construct original sentences using specified vocabulary/grammar
- Short dialogues (2-3 exchanges) demonstrating a concept
- Questions combining two concepts (e.g., negation + conjugation)
- Identify and explain errors in French sentences
- Writing: 2-3 sentences (dialogue exchanges, compound responses)

## Calibration Exemplars
These are real questions at each difficulty level. Match this calibration exactly.

${formatExemplars(selectExemplars(topic))}
Notice: Beginner = one word or one form. Intermediate = one sentence with one grammar rule applied. Advanced = multiple blanks, multiple sentences, or two concepts combined. If a question tests only one concept with a single short answer, it is NOT advanced.

IMPORTANT: "Advanced" means advanced FOR FRENCH 1. All vocabulary and grammar must stay within first-year French. Never require:
- Subjunctive, conditional, passé composé, imparfait
- Abstract/academic vocabulary (e.g., "global job market", "relevant")
- Passive voice
- Complex relative clauses beyond basic qui/que

## Question Quality Rules

1. Each question tests exactly ONE concept
2. Each question has exactly ONE defensible correct answer
3. Questions must be about "${topic}" — not other topics that happen to appear in the materials
4. All French in questions and answers must be grammatically correct
5. Explanations in English, 1-2 sentences
6. NEVER include the answer in the question text:
   - No French answer in parenthetical hints
   - No "Use the structure: '[answer]'" patterns
   - Transformation questions must require meaningful work
7. Vary question phrasing and structure across the batch — use different sentence starters, different prompt styles (translate, complete, write, identify, choose), and different scenarios. Avoid repetitive templates.

## Type-Specific Rules

**multiple-choice**: 4 plausible options. Distractors should test common mistakes (wrong gender, wrong conjugation, false cognates). correctAnswer must exactly match one option.

**true-false**: Clearly, unambiguously true or false statements. options: ["Vrai", "Faux"]. No trick statements based on technicalities.

**fill-in-blank**: Question MUST contain a sentence with "_____" replacing one or more words. Do NOT include options — the student types their answer.
Each "_____" can represent one or more words (e.g., a negation like "n'aime pas" fills ONE blank).
Number of blanks by difficulty: beginner=1 blank, intermediate=1-2 blanks, advanced=2-3 blanks.
correctAnswer format:
  - Single blank: just the answer word(s). Example: "parle" or "n'aime pas"
  - Multiple blanks: comma-separated groups, one group per blank, in order of appearance.
Examples:
  - 1 blank: "Je _____ français." → correctAnswer: "parle"
  - 1 blank (negation): "Elle _____ le sport." → correctAnswer: "n'aime pas"
  - 2 blanks: "Tu _____ le foot et il _____ le tennis." → correctAnswer: "aimes, préfère"
  - 3 blanks: "Le français est officiel au _____, au _____ et au _____." → correctAnswer: "Cameroun, Congo, Gabon"
  - 2 blanks (negation): "Je _____ le foot et tu _____ le tennis." → correctAnswer: "n'aime pas, ne préfères pas"

**writing**: Translations, sentence construction, or short responses. Sentence limits by difficulty: beginner=1 sentence, intermediate=1-2 sentences, advanced=2-3 sentences. correctAnswer is the expected response.
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
` : ''}

## French Grammar Guardrails — MUST follow these rules

All generated French must conform to these rules. Violations will cause the question to be rejected.

**Articles & Partitives**
- General preferences use DEFINITE articles: "J'aime les pommes" (NOT "J'aime des pommes")
- After negation, du/de la/des ALWAYS becomes "de": "Je ne mange pas de pommes" (NOT "pas des pommes"), "Il n'y a pas de lait" (NOT "pas du lait")
- Mandatory contractions: à+le→au, à+les→aux, de+le→du, de+les→des
- No article after "en" for countries/continents: "en France" (NOT "en la France")

**Conjugation & Pronouns**
- "On" ALWAYS takes 3rd person singular: "on aime", "on mange" — even when meaning "we"
- Stressed pronouns after prepositions: "avec moi" (NOT "avec je"), "pour toi", "chez lui"

**Elision**
- Mandatory before vowel sounds and mute h: j'aime, l'école, l'homme, n'aime, d'accord
- Never before consonants: "la liberté" (NOT "l'liberté"), "le livre" (NOT "l'livre")
- "Le haricot" (aspirated h — no elision)

**Semantic Accuracy**
- Use "boire" for beverages: "boire du café" (NOT "manger du café")
- Use "avoir" for physical states: avoir faim, avoir soif, avoir chaud (NOT "être faim")
- Do NOT tie day-of-week to specific calendar dates without year context (e.g., avoid "What day is January 15?")
- Days of the week are NOT capitalized in French: "lundi", "mardi"

## Forbidden Content — DO NOT create questions about:
- Learning philosophy (growth mindset, making mistakes, study tips, language acquisition)
- Teacher information (Monsieur , teacher's background, personal life)
- Course administration (grading, homework, classroom rules, technology policies)
- Class structure, curriculum design, or daily materials needed
- Whether something was "mentioned in the materials" or "listed in the vocabulary"

If the learning materials contain this type of content, IGNORE IT and generate questions only from actual French language content.

## Output
Create EXACTLY ${numQuestions} questions.
${questionType ? `Type: "${questionType}" ONLY — do not create any other type.` : allowedTypes ? `Mix types: ${allowedTypes.join(', ')}. Do not create any other type.` : 'Mix types: multiple-choice, fill-in-blank, true-false, writing.'}

Return ONLY valid JSON:
{
  "questions": [
    {
      "id": "q1",
      "question": "Question text here?",
      "type": "multiple-choice",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctAnswer": "Option B",
      "explanation": "Brief English explanation"
    }
  ]
}

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

    // Enforce type group constraint for hybrid model generation
    if (allowedTypes) {
      const beforeGroupFilter = validQuestions.length;
      validQuestions = validQuestions.filter(q => (allowedTypes as string[]).includes(q.type));
      const groupDrift = beforeGroupFilter - validQuestions.length;
      if (groupDrift > 0) {
        console.log(`    ⚠️  Filtered out ${groupDrift} question(s) outside type group (type drift)`);
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

    // Answer validation + acceptable variation generation
    if (!skipValidation && validQuestions.length > 0) {
      // Step 1: Structural validation (no API call)
      const structural = structuralValidation(validQuestions);
      if (structural.rejected.length > 0) {
        const reasons = structural.rejected.map(r => r.reason);
        const summary = [...new Set(reasons)].join('; ');
        console.log(`    ⚠️  Structural: rejected ${structural.rejected.length} (${summary})`);
      }

      // Step 2: AI answer validation + variation generation
      const aiValidation = await validateAnswers(structural.valid);
      if (aiValidation.rejected.length > 0) {
        for (const r of aiValidation.rejected) {
          console.log(`    ⚠️  Validation rejected: "${r.question.question.substring(0, 60)}..." — ${r.reason}`);
        }
      }

      const withVariations = aiValidation.valid.filter(q => q.acceptableVariations && q.acceptableVariations.length > 0).length;
      if (aiValidation.valid.length > 0) {
        console.log(`    ✓  Validated ${aiValidation.valid.length} questions${withVariations > 0 ? ` (${withVariations} with variations)` : ''}`);
      }

      validQuestions = aiValidation.valid;
    }

    // Enforce exact question count — handles AI self-correction duplicates
    if (validQuestions.length > numQuestions) {
      console.log(`    ⚠️  AI returned ${validQuestions.length} questions (expected ${numQuestions}), truncating`);
      validQuestions = validQuestions.slice(0, numQuestions);
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
  if (options.model) {
    console.log(`   Model:       ${options.model} (override)`);
  } else if (options.questionType) {
    console.log(`   Model:       ${getModelForType(options.questionType)} (auto for ${options.questionType})`);
  } else {
    console.log(`   Model:       hybrid (structured=${MODELS.questionGenerationStructured}, typed=${MODELS.questionGenerationTyped})`);
  }
  console.log(`   Validation:  ${options.skipValidation ? 'SKIPPED' : `on (${MODELS.answerValidation})`}`);
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

        // Determine generation passes: hybrid mode splits into structured + typed
        const useHybridMode = !options.model && !options.questionType;
        const passes: { model: string; count: number; questionType?: QuestionType; writingType?: WritingType; allowedTypes?: QuestionType[] }[] = useHybridMode
          ? [
              { model: MODELS.questionGenerationStructured, count: Math.ceil(options.count / 2), allowedTypes: [...STRUCTURED_TYPES] },
              { model: MODELS.questionGenerationTyped, count: Math.ceil(options.count / 2), allowedTypes: [...TYPED_TYPES] },
            ]
          : [{
              model: options.model || (options.questionType ? getModelForType(options.questionType) : MODELS.questionGenerationStructured),
              count: options.count,
              questionType: options.questionType as QuestionType | undefined,
              writingType: options.writingType,
            }];

        if (options.dryRun) {
          for (const pass of passes) {
            const typeLabel = pass.questionType ? ` ${pass.questionType}` : pass.allowedTypes ? ` [${pass.allowedTypes.join('/')}]` : '';
            const modelShort = pass.model.replace('claude-', '').split('-').slice(0, 2).join('-');
            console.log(`  [DRY RUN] Would generate ${pass.count} ${difficulty}${typeLabel} questions for: ${topic} (${modelShort})`);
          }
          continue;
        }

        for (const pass of passes) {
          const questions = await generateQuestionsForTopic(
            unit.id,
            topic,
            difficulty,
            pass.count,
            pass.questionType,
            pass.writingType,
            pass.model,
            pass.allowedTypes,
            options.skipValidation
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
                pass.model,
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
    // Insert batch metadata record
    if (supabaseClient && totalInserted > 0) {
      const batchModel = options.model || 'hybrid';
      const { error: batchError } = await supabaseClient
        .from('batches')
        .insert({
          id: options.batchId,
          model: batchModel,
          unit_id: options.unitId || 'all',
          difficulty: options.difficulty || 'all',
          type_filter: options.questionType || 'all',
          question_count: totalGenerated,
          inserted_count: totalInserted,
          duplicate_count: totalSkippedDuplicates,
          error_count: totalAttempted - Math.ceil(totalGenerated / options.count),
          config: {
            args: process.argv.slice(2),
            count: options.count,
            model: batchModel,
            structuredModel: MODELS.questionGenerationStructured,
            typedModel: MODELS.questionGenerationTyped,
          },
          prompt_hash: crypto.createHash('sha256')
            .update(MODELS.questionGenerationStructured + MODELS.questionGenerationTyped)
            .digest('hex')
            .substring(0, 16),
        });

      if (batchError) {
        console.error('\n⚠️  Failed to insert batch metadata:', batchError.message);
      } else {
        console.log(`\n📦 Batch metadata saved: ${options.batchId}`);
      }
    }
  } else {
    console.log('\n⚠️  Questions were generated but NOT saved to database.');
    console.log('   Use --write-db flag to persist questions to Supabase.');
  }
}

// Parse CLI args and run the generation
const options = parseArgs();
generateAllQuestions(options).catch(console.error);
