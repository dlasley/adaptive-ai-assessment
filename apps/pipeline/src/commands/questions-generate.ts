/**
 * Script to pre-generate all assessment questions
 *
 * Run with: npm run generate-questions
 *
 * Hybrid Model Generation:
 *   By default, uses Haiku for MCQ/T-F and Sonnet for fill-in-blank/writing.
 *   --model overrides this and uses a single model for all types.
 *   --type auto-selects the appropriate model for that type.
 */

import { loadEnv } from '../lib/env';
import { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchUnitsFromDb } from '../lib/units-db';
import {
  loadUnitMaterials,
  extractTopicContent,
  findUnitHeadingMismatches,
  formatHeadingPreflightError,
  type HeadingRef,
} from '../lib/learning-materials';
import { inferWritingType, WritingType } from '../lib/writing-type-inference';
import {
  MODELS,
  STRUCTURED_TYPES,
  TYPED_TYPES,
  VALIDATION_GROUP_SIZE,
  getModelForType,
  computeQuestionCap,
  MIN_QUESTIONS_PER_TOPIC_DIFFICULTY,
  MAX_QUESTIONS_PER_TOPIC_DIFFICULTY,
  QuestionType,
} from '../lib/pipeline-config';
import { DIFFICULTIES, isDifficulty, type Difficulty } from '@adaptive/shared/enums';
import { getCourse, renderCoursePrompt } from '@adaptive/shared/course';
import { matchMetaQuestionPattern, type MetaQuestionPattern } from '@adaptive/shared/meta-question-filter';
import { getGitInfo } from '../lib/git-state';
import { createScriptSupabase } from '../lib/db-queries';
import { structuralValidation } from '../lib/structural-validation';
import { defineCli } from '../lib/options/define-cli';
import { dbTargetFlags, questionFilterFlags, loggingFlags } from '../lib/options/groups';
import { callLlm, LlmResult } from '@adaptive/shared/llm';
import { createLogger } from '../lib/logger';
import { bootstrapCommand } from '../lib/command-bootstrap';
import { PROMPTS_DIR } from '../lib/paths';
import { runIfMain } from '../lib/run-if-main';
import {
  addStageUsageTotals,
  addUsageTotals,
  emptyStageUsage,
  emptyUsageTotals,
  formatUsageSummary,
  recordCall,
  type StageUsage,
} from '../lib/usage-tracking';

const logger = createLogger('questions-generate');

interface Question {
  id: string;
  question: string;
  type: QuestionType;
  options?: string[];
  correctAnswer: string;
  explanation?: string;
  unitId: string;
  topic: string;
  difficulty: Difficulty;
  acceptableVariations?: string[];
  contentHash?: string;
  batchId?: string;
  sourceFile?: string;
}

// Exemplar pool for difficulty calibration — rotated per topic to reduce homogeneity
interface Exemplar { type: string; question: string; answer: string }
const EXEMPLAR_POOL: Record<string, Exemplar[]> = {
  beginner: [
    // Single-concept recall: vocabulary identification, single conjugation, simple facts
    { type: 'fill-in-blank', question: 'Conjugate \'se lever\' for the subject \'je\': _____', answer: 'me lève' },
    { type: 'fill-in-blank', question: 'Hier, j\'_____ (regarder) la télé.', answer: 'ai regardé' },
    { type: 'fill-in-blank', question: 'The French word for \'yesterday\' is _____.', answer: 'hier' },
    { type: 'writing', question: 'Conjugate the verb \'finir\' in the passé composé for the subject pronoun \'tu\'.', answer: 'Tu as fini.' },
    { type: 'writing', question: 'Translate to French: \'I will eat.\'', answer: 'Je mangerai.' },
    { type: 'writing', question: 'Write the infinitive form of the reflexive verb meaning \'to wake up\'.', answer: 'se réveiller' },
    { type: 'multiple-choice', question: 'What does \'hier\' mean?', answer: 'Yesterday' },
    { type: 'multiple-choice', question: 'Which pronoun replaces \'le livre\' in \'Je lis le livre\'?', answer: 'le' },
    { type: 'true-false', question: 'Vrai ou Faux: \'Se laver\' means \'to wash oneself\'.', answer: 'Vrai' },
  ],
  intermediate: [
    // One grammar rule applied in context: tense choice, pronoun placement, reflexive conjugation
    { type: 'fill-in-blank', question: 'Hier soir, nous _____ (regarder) un film.', answer: 'avons regardé' },
    { type: 'fill-in-blank', question: 'Quand j\'étais petit, je _____ (jouer) au parc tous les jours.', answer: 'jouais' },
    { type: 'fill-in-blank', question: 'Tu _____ (se lever) tôt le matin.', answer: 'te lèves' },
    { type: 'writing', question: 'Translate to French: \'We watched a movie yesterday.\'', answer: 'Nous avons regardé un film hier.' },
    { type: 'writing', question: 'Write a sentence saying what you used to do on weekends, using the imparfait.', answer: 'Je jouais au foot le week-end.' },
    { type: 'writing', question: 'Rewrite this sentence replacing the underlined object with a pronoun: \'Je vois Marie.\'', answer: 'Je la vois.' },
    { type: 'multiple-choice', question: 'Choose the correct sentence: "Je le vois" / "Je vois le" / "Je vois il" / "Le je vois"', answer: 'Je le vois' },
    { type: 'multiple-choice', question: 'Which is correct for \'next year\'? "L\'année prochaine, je voyagerai" / "L\'année prochaine, je voyage" / "L\'année prochaine, je voyageais" / "L\'année prochaine, j\'ai voyagé"', answer: 'L\'année prochaine, je voyagerai' },
    { type: 'true-false', question: 'Vrai ou Faux: In \'Je me lave les mains,\' \'me\' is a reflexive pronoun.', answer: 'Vrai' },
  ],
  advanced: [
    // Two+ grammar concepts combined: reflexive + passé composé, imparfait vs. passé composé,
    // object pronoun + past participle agreement
    { type: 'fill-in-blank', question: 'Hier, je _____ (se réveiller) tard et j\'_____ (manger) rapidement.', answer: 'me suis réveillé, ai mangé' },
    { type: 'fill-in-blank', question: 'Quand j\'étais jeune, je _____ (aller) à la piscine tous les étés, mais l\'été dernier, je n\'y _____ (aller).', answer: 'allais, suis pas allé' },
    { type: 'fill-in-blank', question: 'La pomme, je _____ (manger) ce matin.', answer: 'l\'ai mangée' },
    { type: 'writing', question: 'Write two sentences about your childhood routine using the imparfait and a reflexive verb.', answer: 'Je me réveillais tôt. Je me brossais les dents avant l\'école.' },
    { type: 'writing', question: 'Write a sentence using a direct object pronoun and the passé composé together.', answer: 'Je l\'ai vu hier.' },
    { type: 'writing', question: 'Write a sentence saying you did not go somewhere yesterday, using the passé composé and negation.', answer: 'Je ne suis pas allé au cinéma hier.' },
    { type: 'multiple-choice', question: 'Which sentence correctly shows past participle agreement with a preceding direct object? "La pomme, je l\'ai mangée" / "La pomme, je l\'ai mangé" / "La pomme, j\'ai mangée" / "La pomme, je mangée l\'ai"', answer: 'La pomme, je l\'ai mangée' },
    { type: 'true-false', question: 'Vrai ou Faux: In "Elle s\'est lavée," the past participle agrees with the reflexive pronoun because it acts as a direct object.', answer: 'Vrai' },
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
export const cli = defineCli(
  {
    ...dbTargetFlags,
    ...questionFilterFlags,
    ...loggingFlags,
    topic: { type: 'string', help: 'Generate for specific topic only', group: 'Filters' },
    'batch-id': {
      type: 'string',
      default: `batch_${new Date().toISOString().split('T')[0]}_${Date.now()}`,
      help: 'Custom batch ID',
    },
    count: {
      type: 'number',
      min: 1,
      help: `Questions per topic/difficulty (default: auto — a per-topic cap computed from content length, ${MIN_QUESTIONS_PER_TOPIC_DIFFICULTY}-${MAX_QUESTIONS_PER_TOPIC_DIFFICULTY})`,
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      help: 'Show what would be generated without actually generating',
    },
    'source-file': { type: 'string', help: 'Source learning material file path for tracking' },
    model: { type: 'string', help: 'Override model for ALL types (disables hybrid mode)' },
    'skip-validation': {
      type: 'boolean',
      default: false,
      help: 'Skip answer validation (faster, no variation generation)',
    },
    'generation-model-structured': {
      type: 'string',
      help: 'Override structured question generation model',
    },
    'generation-model-typed': { type: 'string', help: 'Override typed question generation model' },
    'validation-model': { type: 'string', help: 'Override answer validation model' },
  },
  {
    name: 'questions-generate',
    description: 'Generate assessment questions (Stage 1 + Stage 2 validation).',
    examples: [
      'npx tsx apps/pipeline/src/commands/questions-generate.ts --unit unit-3 --write-db          # Hybrid mode',
      'npx tsx apps/pipeline/src/commands/questions-generate.ts --unit unit-3 --type writing      # Sonnet auto-selected',
      'npx tsx apps/pipeline/src/commands/questions-generate.ts --model anthropic/claude-haiku-4.5 # Force single model',
      'npx tsx apps/pipeline/src/commands/questions-generate.ts --type writing --writing-type conjugation --write-db',
      'npx tsx apps/pipeline/src/commands/questions-generate.ts --write-db --dry-run',
    ],
    validate: (o) => {
      if (o.writingType && o.type !== 'writing') return '--writing-type requires --type writing';
    },
  },
);

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
 * Fetch existing content hashes from database for deduplication.
 */
async function fetchExistingHashes(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('questions')
    .select('content_hash')
    .not('content_hash', 'is', null);

  if (error) {
    logger.error('Error fetching existing hashes', { error });
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
  sourceFile?: string,
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

    const record: Record<string, unknown> = {
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
      has_complete_sentence_requirement: false,
      content_hash: q.contentHash,
      batch_id: batchId,
      source_file: sourceFile,
      generated_by: generatedBy,
      quality_status: 'pending',
    };

    return record;
  });

  const { error } = await supabase
    .from('questions')
    .insert(dbRecords);

  if (error) {
    logger.error('Error inserting questions', { error });
    return { inserted: 0, skipped };
  }

  return { inserted: newQuestions.length, skipped };
}

/**
 * Generation-only patterns layered on top of the shared core (teacher biographical info,
 * pedagogical tips, classroom retrospection, course structure, material meta-references).
 * Generation filters more aggressively than serving because a dropped generated question is
 * cheap to replace, while one that slips through reaches the audit.
 */
export const GENERATION_ONLY_META_PATTERNS: MetaQuestionPattern[] = [
  { pattern: /\b(mr|mrs|mme|m)\.\s*[a-z]{2,}/i, rule: 'teacher-title' },
  { pattern: /\bmonsieur\s+[a-z]{2,}/i, rule: 'teacher-monsieur' },
  { pattern: /\bmadame\s+[a-z]{2,}/i, rule: 'teacher-madame' },
  { pattern: /teacher.*lived/i, rule: 'teacher-lived' },
  { pattern: /teacher.*speaks.*languages/i, rule: 'teacher-speaks-languages' },
  { pattern: /teacher.*interests/i, rule: 'teacher-interests' },
  { pattern: /teacher.*hobbies/i, rule: 'teacher-hobbies' },
  { pattern: /teacher.*books/i, rule: 'teacher-books' },
  { pattern: /teacher.*(favorite|favourite)/i, rule: 'teacher-favorite' },
  { pattern: /study\s*(tip|technique|strategy|method)/i, rule: 'study-tip' },
  { pattern: /best way to (learn|study|memorize|practice)/i, rule: 'best-way-to-learn' },
  { pattern: /tip.*for.*(pronounc|learn|study|memoriz)/i, rule: 'tip-for-pronunciation' },
  { pattern: /how to study/i, rule: 'how-to-study' },
  { pattern: /did we.*learn/i, rule: 'did-we-learn' },
  { pattern: /what.*we.*cover/i, rule: 'what-we-cover' },
  { pattern: /what.*we.*study/i, rule: 'what-we-study' },
  { pattern: /what.*we.*learn.*in class/i, rule: 'what-we-learn-in-class' },
  { pattern: /four key skills/i, rule: 'four-key-skills' },
  { pattern: /course structure/i, rule: 'course-structure' },
  { pattern: /class structure/i, rule: 'class-structure' },
  { pattern: /mentioned in (the )?(vocabulary|materials|list)/i, rule: 'mentioned-in-materials' },
  { pattern: /\b(listed|included) in the (vocabulary|materials|list)/i, rule: 'listed-in-materials' },
  { pattern: /not.*mentioned/i, rule: 'not-mentioned' },
  { pattern: /which.*not.*(classroom object|vocabulary item)/i, rule: 'which-not-vocabulary-item' },
];

/**
 * Check if a question is a meta-question about learning philosophy or teacher information. Checks
 * the shared core (`@adaptive/shared/meta-question-filter`, also used by the app's serving-time
 * filter) plus the generation-only patterns above.
 */
export function isMetaQuestion(question: Question): boolean {
  if (matchMetaQuestionPattern(question.question, question.explanation)) return true;

  const combinedText = `${question.question} ${question.explanation || ''}`;
  return GENERATION_ONLY_META_PATTERNS.some(({ pattern }) => pattern.test(combinedText));
}

// Raw template, not yet rendered — a plain file read, safe at module scope. The render step
// happens in renderValidationPrompt(), which only runs once main() (or a test that calls it
// directly) actually needs the text, never merely from importing this module.
const RAW_VALIDATION_PROMPT = readFileSync(join(PROMPTS_DIR, 'questions-validate.md'), 'utf-8').trim();

export function renderValidationPrompt(): string {
  return renderCoursePrompt(RAW_VALIDATION_PROMPT).replaceAll('{{OUT_OF_SCOPE}}', getCourse().level.outOfScope.join(', '));
}

const GENERATION_PROMPT_TEMPLATE = readFileSync(
  join(PROMPTS_DIR, 'questions-generate.md'),
  'utf-8'
).trim();

/** The `{{WRITING_TYPE_BLOCK}}` placeholder's fill: empty unless a specific writing subtype is pinned. */
export function buildWritingTypeBlock(writingType?: WritingType): string {
  if (!writingType) return '';
  return `
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
`;
}

/** The `{{TYPE_INSTRUCTION}}` placeholder's fill. */
export function buildTypeInstruction(questionType?: QuestionType, allowedTypes?: QuestionType[]): string {
  if (questionType) return `Type: "${questionType}" ONLY — do not create any other type.`;
  if (allowedTypes) return `Mix types: ${allowedTypes.join(', ')}. Do not create any other type.`;
  return 'Mix types: multiple-choice, fill-in-blank, true-false, writing.';
}

export function renderGenerationPrompt(params: {
  topic: string;
  difficulty: Difficulty;
  topicContent: string;
  numQuestions: number;
  writingType?: WritingType;
  questionType?: QuestionType;
  allowedTypes?: QuestionType[];
}): string {
  const course = getCourse();
  return renderCoursePrompt(GENERATION_PROMPT_TEMPLATE)
    .replaceAll('{{TOPIC}}', params.topic)
    .replaceAll('{{DIFFICULTY}}', params.difficulty)
    .replaceAll('{{PRIOR_KNOWLEDGE}}', course.level.priorKnowledge)
    .replaceAll('{{TOPIC_CONTENT}}', params.topicContent)
    .replaceAll('{{EXEMPLARS}}', formatExemplars(selectExemplars(params.topic)))
    .replaceAll('{{COURSE_NAME_UPPER}}', course.name.toUpperCase())
    .replaceAll('{{SCOPE}}', course.level.scope)
    .replaceAll(
      '{{OUT_OF_SCOPE_LIST}}',
      course.level.outOfScope.map((item) => `- ${item[0].toUpperCase()}${item.slice(1)}`).join('\n')
    )
    .replaceAll('{{WRITING_TYPE_BLOCK}}', buildWritingTypeBlock(params.writingType))
    .replaceAll('{{NUM_QUESTIONS}}', String(params.numQuestions))
    .replaceAll('{{TYPE_INSTRUCTION}}', buildTypeInstruction(params.questionType, params.allowedTypes));
}

/**
 * sha256 (16 hex) of the rendered prompt content itself — the generation template after
 * course-level placeholder substitution, plus the full validation template — rather than the
 * model names. A prompt-wording change is visible in provenance even when the model stays the
 * same; per-topic placeholders (topic, difficulty, content) aren't included, since those vary
 * every call and would make every batch's hash unique regardless of prompt wording.
 */
export function computeGenerationPromptHash(): string {
  return crypto.createHash('sha256')
    .update(renderCoursePrompt(GENERATION_PROMPT_TEMPLATE) + renderValidationPrompt())
    .digest('hex')
    .substring(0, 16);
}

interface ValidationResult {
  id: string;
  answer_valid: boolean;
  acceptable_variations: string[];
  suggested_difficulty?: Difficulty;
  notes: string;
}

export interface ValidationOutcome {
  valid: Question[];
  /** Explicitly rejected by the validator (answer_valid: false). */
  rejected: { question: Question; reason: string }[];
  /** No result in an otherwise-parseable response carried this question's id. */
  unmatched: { question: Question; reason: string }[];
  /** The group's response failed to parse or the call itself failed — every question in the
   * group lands here, since no per-question verdict exists to consult. */
  errored: { question: Question; reason: string }[];
  difficultyRelabeled: number;
}

/**
 * AI-powered answer validation + acceptable variation generation.
 * Batches questions in groups of ~5 for efficiency.
 * Returns only questions that pass validation, with acceptableVariations populated.
 *
 * Each question in a batch is labeled `q1`, `q2`, ... in the prompt (see the "id" field
 * `prompts/questions-validate.md` documents in its response format) and results are matched back
 * to questions by that label, never by array position — a short, reordered, or malformed response
 * must not silently validate the wrong question or let one through unverified.
 */
async function validateAnswers(questions: Question[], batchId: string, usage: StageUsage): Promise<ValidationOutcome> {
  if (questions.length === 0) return { valid: [], rejected: [], unmatched: [], errored: [], difficultyRelabeled: 0 };

  const allValid: Question[] = [];
  const allRejected: { question: Question; reason: string }[] = [];
  const allUnmatched: { question: Question; reason: string }[] = [];
  const allErrored: { question: Question; reason: string }[] = [];
  let difficultyRelabeled = 0;

  for (let i = 0; i < questions.length; i += VALIDATION_GROUP_SIZE) {
    const batch = questions.slice(i, i + VALIDATION_GROUP_SIZE);
    const labeledBatch = batch.map((q, idx) => ({ q, label: `q${idx + 1}` }));

    const questionsText = labeledBatch.map(({ q, label }, idx) => {
      const optionsText = q.options ? `\nOptions: ${q.options.join(' / ')}` : '';
      return `Question ${idx + 1} (id: ${label}, ${q.type}, ${q.difficulty}):
Q: ${q.question}${optionsText}
A: ${q.correctAnswer}`;
    }).join('\n\n');

    let results: ValidationResult[] | null = null;
    let failureReason: string | null = null;
    let calledOk = false;

    try {
      const result = await callLlm({
        model: MODELS.answerValidation,
        maxTokens: 2000,
        disableReasoning: true,
        messages: [
          { role: 'user', content: `${renderValidationPrompt()}\n\n---\n\n${questionsText}` },
        ],
        sessionId: `${batchId}:validation`,
      });
      // Cost is incurred whether or not the response parses, so the call is recorded here —
      // before json_failures (below) tracks whether it was usable.
      recordCall(usage, result.usage);
      calledOk = true;

      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        failureReason = 'no JSON object found in validation response';
      } else {
        const parsed = JSON.parse(jsonMatch[0].replace(/,(\s*[}\]])/g, '$1'));
        if (!Array.isArray(parsed.results)) {
          failureReason = 'validation response had no results array';
        } else {
          results = parsed.results;
        }
      }
    } catch (error) {
      // A callLlm failure (network, auth, rate limit) never returned a response — nothing to
      // record as a call, and it isn't a JSON failure.
      failureReason = error instanceof Error ? error.message : 'unknown validation error';
    }

    if (calledOk && failureReason) {
      usage.json_failures++;
    }

    if (failureReason || !results) {
      logger.warn(`Validation group failed — rejecting ${batch.length} question(s): ${failureReason}`, {
        questionIds: batch.map((q) => q.id),
      });
      for (const q of batch) {
        allErrored.push({ question: q, reason: `VALIDATION_ERROR: ${failureReason}` });
      }
      continue;
    }

    const resultByLabel = new Map<string, ValidationResult>();
    for (const r of results) {
      if (r && typeof r.id === 'string') resultByLabel.set(r.id, r);
    }

    for (const { q, label } of labeledBatch) {
      const result = resultByLabel.get(label);

      if (!result) {
        allUnmatched.push({ question: q, reason: 'no matching validation result returned' });
        continue;
      }

      if (result.answer_valid) {
        if ((q.type === 'fill-in-blank' || q.type === 'writing') && result.acceptable_variations?.length > 0) {
          q.acceptableVariations = result.acceptable_variations;
        }
        // Re-label difficulty if validator disagrees
        const suggested = result.suggested_difficulty;
        if (suggested && isDifficulty(suggested) && suggested !== q.difficulty) {
          console.log(`    ⚠️  Difficulty re-label: "${q.question.substring(0, 50)}..." ${q.difficulty} → ${suggested}`);
          q.difficulty = suggested;
          difficultyRelabeled++;
        }
        allValid.push(q);
      } else {
        allRejected.push({ question: q, reason: result.notes || 'Answer incorrect' });
      }
    }
  }

  return { valid: allValid, rejected: allRejected, unmatched: allUnmatched, errored: allErrored, difficultyRelabeled };
}

async function callGenerationModel(model: string, prompt: string, batchId: string): Promise<LlmResult> {
  const isMistral = model.startsWith('mistralai/');
  return callLlm({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: isMistral ? 0.7 : undefined,
    maxTokens: isMistral ? undefined : 4000,
    disableReasoning: true,
    jsonMode: isMistral,
    sessionId: `${batchId}:generation`,
  });
}

interface GenerationStats {
  meta_filtered: number;
  type_drift: number;
  structural_rejected: number;
  validation_rejected: number;
  /** Questions a parseable validation response never returned a result for. */
  validation_unmatched: number;
  /** Questions rejected wholesale because their validation group's response failed to parse. */
  validation_errors: number;
  difficulty_relabeled: number;
}

const EMPTY_STATS: GenerationStats = {
  meta_filtered: 0,
  type_drift: 0,
  structural_rejected: 0,
  validation_rejected: 0,
  validation_unmatched: 0,
  validation_errors: 0,
  difficulty_relabeled: 0,
};

export async function generateQuestionsForTopic(
  unitId: string,
  topic: string,
  difficulty: Difficulty,
  numQuestions: number,
  units: Array<{ id: string; source_file_stem?: string | null; topics: Array<{ name: string; headings: HeadingRef[] }> }>,
  batchId: string,
  questionType?: QuestionType,
  writingType?: WritingType,
  modelOverride?: string,
  allowedTypes?: QuestionType[],
  skipValidation?: boolean
): Promise<{ questions: Question[]; stats: GenerationStats; usage: { generation: StageUsage; validation: StageUsage } }> {
  const typeLabel = questionType ? ` ${questionType}` : allowedTypes ? ` [${allowedTypes.join('/')}]` : '';
  const subtypeLabel = writingType ? ` (${writingType})` : '';
  const usage = { generation: emptyStageUsage(), validation: emptyStageUsage() };

  try {
    const unitMaterials = loadUnitMaterials(unitId, units);
    const topicContent = extractTopicContent(unitMaterials, topic, units);

    if (!topicContent) {
      console.log(`  ⚠️  Skipping ${difficulty}${typeLabel}${subtypeLabel} questions for "${topic}" — no source content found`);
      return { questions: [], stats: { ...EMPTY_STATS }, usage };
    }

    console.log(`  Generating up to ${numQuestions} ${difficulty}${typeLabel}${subtypeLabel} questions for: ${topic}`);

    const prompt = renderGenerationPrompt({
      topic,
      difficulty,
      topicContent,
      numQuestions,
      writingType,
      questionType,
      allowedTypes,
    });

    const generationResult = await callGenerationModel(
      modelOverride || MODELS.questionGenerationStructured,
      prompt,
      batchId
    );
    recordCall(usage.generation, generationResult.usage);
    const responseText = generationResult.text;

    // Try to extract JSON more robustly
    let jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
      usage.generation.json_failures++;
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
      usage.generation.json_failures++;
      logger.error('JSON parse error', {
        error: parseError,
        attempted: jsonText.substring(0, 500) + '...',
      });
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
    const questions: Question[] = parsedResponse.questions.map((q: any, idx: number) => ({
      ...q,
      id: `${unitId}_${topic.replace(/\s+/g, '_')}_${difficulty}_q${idx + 1}`,
      unitId,
      topic,
      difficulty,
    }));

    // Track per-topic quality metrics
    const stats: GenerationStats = { ...EMPTY_STATS };

    // Filter out any meta-questions that slipped through
    let validQuestions = questions.filter(q => !isMetaQuestion(q));
    stats.meta_filtered = questions.length - validQuestions.length;

    if (stats.meta_filtered > 0) {
      console.log(`    ⚠️  Filtered out ${stats.meta_filtered} meta-question(s)`);
    }

    // Enforce type constraint when --type flag is used (prevent AI type drift)
    if (questionType) {
      const beforeTypeFilter = validQuestions.length;
      validQuestions = validQuestions.filter(q => q.type === questionType);
      const typeDrift = beforeTypeFilter - validQuestions.length;
      stats.type_drift += typeDrift;
      if (typeDrift > 0) {
        console.log(`    ⚠️  Filtered out ${typeDrift} question(s) with wrong type (type drift)`);
      }
    }

    // Enforce type group constraint for hybrid model generation
    if (allowedTypes) {
      const beforeGroupFilter = validQuestions.length;
      validQuestions = validQuestions.filter(q => (allowedTypes as string[]).includes(q.type));
      const groupDrift = beforeGroupFilter - validQuestions.length;
      stats.type_drift += groupDrift;
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
      stats.type_drift += writingDrift;
      if (writingDrift > 0) {
        console.log(`    ⚠️  Filtered out ${writingDrift} question(s) with wrong writing type (writing type drift)`);
      }
    }

    // Answer validation + acceptable variation generation
    if (!skipValidation && validQuestions.length > 0) {
      // Step 1: Structural validation (no API call)
      const structural = structuralValidation(validQuestions);
      stats.structural_rejected = structural.rejected.length;
      if (structural.rejected.length > 0) {
        const reasons = structural.rejected.map(r => r.reason);
        const summary = [...new Set(reasons)].join('; ');
        console.log(`    ⚠️  Structural: rejected ${structural.rejected.length} (${summary})`);
      }

      // Step 2: AI answer validation + variation generation
      const aiValidation = await validateAnswers(structural.valid, batchId, usage.validation);
      stats.validation_rejected = aiValidation.rejected.length;
      stats.validation_unmatched = aiValidation.unmatched.length;
      stats.validation_errors = aiValidation.errored.length;
      stats.difficulty_relabeled = aiValidation.difficultyRelabeled;
      if (aiValidation.rejected.length > 0) {
        for (const r of aiValidation.rejected) {
          console.log(`    ⚠️  Validation rejected: "${r.question.question.substring(0, 60)}..." — ${r.reason}`);
        }
      }
      if (aiValidation.unmatched.length > 0) {
        for (const r of aiValidation.unmatched) {
          console.log(`    ⚠️  Validation unmatched: "${r.question.question.substring(0, 60)}..." — ${r.reason}`);
        }
      }
      if (aiValidation.errored.length > 0) {
        console.log(`    ⚠️  Validation errors: ${aiValidation.errored.length} question(s) rejected (group response failed to parse)`);
      }

      const withVariations = aiValidation.valid.filter(q => q.acceptableVariations && q.acceptableVariations.length > 0).length;
      if (aiValidation.valid.length > 0) {
        const relabelNote = aiValidation.difficultyRelabeled > 0 ? `, ${aiValidation.difficultyRelabeled} re-labeled` : '';
        console.log(`    ✓  Validated ${aiValidation.valid.length} questions${withVariations > 0 ? ` (${withVariations} with variations${relabelNote})` : relabelNote ? ` (${relabelNote.substring(2)})` : ''}`);
      }

      validQuestions = aiValidation.valid;
    }

    // Enforce the upper bound — handles AI self-correction duplicates. Returning fewer than
    // numQuestions is expected and not an error: a thin topic runs out of distinct material
    // before it runs out of budget.
    if (validQuestions.length > numQuestions) {
      console.log(`    ⚠️  AI returned ${validQuestions.length} questions (requested up to ${numQuestions}), truncating`);
      validQuestions = validQuestions.slice(0, numQuestions);
    }
    console.log(`    Requested up to ${numQuestions}, got ${validQuestions.length}`);

    return { questions: validQuestions, stats, usage };
  } catch (error) {
    logger.error(`Error generating questions for ${topic} (${difficulty})`, { error });
    return { questions: [], stats: { ...EMPTY_STATS }, usage };
  }
}

export async function generateAllQuestions(options: ReturnType<typeof cli.parse>) {
  console.log('🚀 Starting question generation...\n');
  console.log('Configuration:');
  console.log(`   Unit:        ${options.unit || 'all'}`);
  console.log(`   Topic:       ${options.topic || 'all'}`);
  console.log(`   Difficulty:  ${options.difficulty || 'all'}`);
  console.log(
    `   Count:       ${options.count !== undefined
      ? `${options.count} per topic/difficulty (override)`
      : `auto per topic/difficulty (computed cap, ${MIN_QUESTIONS_PER_TOPIC_DIFFICULTY}-${MAX_QUESTIONS_PER_TOPIC_DIFFICULTY})`}`
  );
  console.log(`   Sync to DB:  ${options.writeDb ? 'yes' : 'no'}`);
  console.log(`   Dry run:     ${options.dryRun ? 'yes' : 'no'}`);
  console.log(`   Batch ID:    ${options.batchId}`);
  if (options.model) {
    console.log(`   Model:       ${options.model} (override)`);
  } else if (options.type) {
    console.log(`   Model:       ${getModelForType(options.type)} (auto for ${options.type})`);
  } else {
    console.log(`   Model:       hybrid (structured=${MODELS.questionGenerationStructured}, typed=${MODELS.questionGenerationTyped})`);
  }
  console.log(`   Validation:  ${options.skipValidation ? 'SKIPPED' : `on (${MODELS.answerValidation})`}`);
  if (options.sourceFile) {
    console.log(`   Source file: ${options.sourceFile}`);
  }
  console.log();

  // Git info (records provenance for batch config)
  const gitInfo = getGitInfo();

  // Initialize Supabase if syncing to database
  let supabaseClient: SupabaseClient | null = null;
  let existingHashes = new Set<string>();

  if (options.writeDb) {
    supabaseClient = createScriptSupabase({ write: true });
    console.log('📡 Fetching existing content hashes for deduplication...');
    existingHashes = await fetchExistingHashes(supabaseClient);
    console.log(`   Found ${existingHashes.size} existing question hashes\n`);

    // Insert preliminary batch record (updated with final stats at end)
    const batchModel = options.model || 'hybrid';
    const structuredModel = options.generationModelStructured || MODELS.questionGenerationStructured;
    const typedModel = options.generationModelTyped || MODELS.questionGenerationTyped;
    const validationModel = options.validationModel || MODELS.answerValidation;

    const preliminaryBatch: Record<string, unknown> = {
      id: options.batchId,
      model: batchModel,
      unit_id: options.unit || 'all',
      difficulty: options.difficulty || 'all',
      type_filter: options.type || 'all',
      question_count: 0,
      inserted_count: 0,
      duplicate_count: 0,
      error_count: 0,
      config: {
        git: { branch: gitInfo.branch, commit: gitInfo.commit },
        models: {
          generation_structured: structuredModel,
          generation_typed: typedModel,
          validation: validationModel,
          audit: MODELS.mistralAudit,
          pdf_conversion: MODELS.pdfConversion,
          topic_extraction: MODELS.topicExtraction,
        },
        cli_args: {
          unit: options.unit || null,
          type: options.type || null,
          difficulty: options.difficulty || null,
          batch_id: options.batchId,
          source_file: options.sourceFile || null,
        },
      },
      quality_metrics: {},
      prompt_hash: computeGenerationPromptHash(),
    };

    const { error: batchInsertError } = await supabaseClient
      .from('batches')
      .insert(preliminaryBatch);

    if (batchInsertError) {
      logger.error('Failed to create batch record', { message: batchInsertError.message });
      process.exit(1);
    }
    console.log(`📦 Batch record created: ${options.batchId}`);
  }

  // Fetch units from database
  const dbClient = supabaseClient || createScriptSupabase();
  const units = await fetchUnitsFromDb(dbClient);

  const allQuestions: Question[] = [];
  let totalGenerated = 0;
  let totalAttempted = 0;
  let totalSkippedDuplicates = 0;
  let totalInserted = 0;
  let zeroQuestionCombos = 0;
  let dryRunEstimatedTotal = 0;
  const aggregateStats: GenerationStats = { ...EMPTY_STATS };
  const aggregateUsage = { generation: emptyStageUsage(), validation: emptyStageUsage() };

  // Filter units based on CLI options
  const unitsToProcess = options.unit
    ? units.filter(u => u.id === options.unit)
    : units;

  if (unitsToProcess.length === 0) {
    logger.error(`Unit not found: ${options.unit}`, { availableUnits: units.map(u => u.id) });
    process.exit(1);
  }

  // Preflight: every topic with stored headings must resolve against its unit's current
  // markdown before any model call. A topic whose headings don't validate would otherwise
  // silently generate zero questions (extractTopicContent returns empty, and generation skips
  // it with a per-topic warning) — this turns that into a hard failure naming the unit.
  for (const unit of unitsToProcess) {
    const materials = loadUnitMaterials(unit.id, units);
    const mismatches = findUnitHeadingMismatches(materials, unit.topics);
    if (mismatches.length > 0) {
      logger.error(formatHeadingPreflightError(unit.id, mismatches));
      process.exit(1);
    }
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
      // Content doesn't vary by difficulty, so the cap is computed once per topic. An explicit
      // --count overrides it for every topic/difficulty in this run.
      const unitMaterials = loadUnitMaterials(unit.id, units);
      const topicContent = extractTopicContent(unitMaterials, topic, units);
      const computedCap = computeQuestionCap(topicContent.length);
      const effectiveCount = options.count ?? computedCap;
      const capNote = options.count !== undefined
        ? `--count override: ${options.count}`
        : `computed cap: ${computedCap} (${topicContent.length} chars)`;
      console.log(`  Topic: ${topic} — ${capNote}`);

      // Filter difficulties based on CLI options
      const difficultiesToProcess = options.difficulty
        ? [options.difficulty]
        : DIFFICULTIES;

      for (const difficulty of difficultiesToProcess) {
        totalAttempted++;

        // Determine generation passes: hybrid mode splits into structured + typed
        // For advanced difficulty, use Sonnet for all types (better calibration)
        const useHybridMode = !options.model && !options.type && difficulty !== 'advanced';
        // ceil + floor (not ceil twice) so the two passes always sum to exactly effectiveCount,
        // even when it's odd. A pass with a 0 count (only possible when effectiveCount is 1, via
        // an explicit --count 1) is dropped rather than requesting 0 questions.
        const passes: { model: string; count: number; questionType?: QuestionType; writingType?: WritingType; allowedTypes?: QuestionType[] }[] = useHybridMode
          ? [
              { model: MODELS.questionGenerationStructured, count: Math.ceil(effectiveCount / 2), allowedTypes: [...STRUCTURED_TYPES] },
              { model: MODELS.questionGenerationTyped, count: Math.floor(effectiveCount / 2), allowedTypes: [...TYPED_TYPES] },
            ].filter(pass => pass.count > 0)
          : [{
              model: options.model || (options.type ? getModelForType(options.type) : (difficulty === 'advanced' ? MODELS.questionGenerationTyped : MODELS.questionGenerationStructured)),
              count: effectiveCount,
              questionType: options.type as QuestionType | undefined,
              writingType: options.writingType,
            }];

        if (options.dryRun) {
          for (const pass of passes) {
            const typeLabel = pass.questionType ? ` ${pass.questionType}` : pass.allowedTypes ? ` [${pass.allowedTypes.join('/')}]` : '';
            const modelShort = pass.model.replace('claude-', '').split('-').slice(0, 2).join('-');
            console.log(`  [DRY RUN] Would generate up to ${pass.count} ${difficulty}${typeLabel} questions for: ${topic} (${modelShort})`);
            dryRunEstimatedTotal += pass.count;
          }
          continue;
        }

        let difficultyQuestionsGenerated = 0;

        for (const pass of passes) {
          const result = await generateQuestionsForTopic(
            unit.id,
            topic,
            difficulty,
            pass.count,
            units,
            options.batchId,
            pass.questionType,
            pass.writingType,
            pass.model,
            pass.allowedTypes,
            options.skipValidation
          );

          // Aggregate quality stats across all passes
          for (const key of Object.keys(result.stats) as (keyof GenerationStats)[]) {
            aggregateStats[key] += result.stats[key];
          }
          addStageUsageTotals(aggregateUsage.generation, result.usage.generation);
          addStageUsageTotals(aggregateUsage.validation, result.usage.validation);

          difficultyQuestionsGenerated += result.questions.length;

          if (result.questions.length > 0) {
            // Add content hashes and batch metadata to each question
            const questionsWithHashes = result.questions.map((q: Question) => ({
              ...q,
              contentHash: computeContentHash(q.question, q.correctAnswer, q.topic, q.difficulty),
              batchId: options.batchId,
              sourceFile: options.sourceFile,
            }));

            allQuestions.push(...questionsWithHashes);
            totalGenerated += questionsWithHashes.length;

            // Sync to database if enabled
            if (options.writeDb && supabaseClient) {
              const { inserted, skipped } = await syncToDatabase(
                supabaseClient,
                questionsWithHashes,
                existingHashes,
                options.batchId,
                pass.model,
                options.sourceFile,
              );
              totalInserted += inserted;
              totalSkippedDuplicates += skipped;

              // Add newly inserted hashes to the set to avoid duplicates within the same run
              for (const q of questionsWithHashes) {
                if (q.contentHash) existingHashes.add(q.contentHash);
              }

              if (inserted > 0 || skipped > 0) {
                console.log(`    ✅ Generated ${result.questions.length} | Inserted ${inserted} | Skipped ${skipped} duplicates`);
              } else {
                console.log(`    ✅ Generated ${result.questions.length} questions`);
              }
            } else {
              console.log(`    ✅ Generated ${result.questions.length} questions`);
            }
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (difficultyQuestionsGenerated === 0) zeroQuestionCombos++;
      }
    }
  }

  if (options.dryRun) {
    const estimatedQuestions = dryRunEstimatedTotal;
    console.log('\n\n📋 DRY RUN Summary:');
    console.log(`   Would process: ${totalAttempted} topic/difficulty combinations`);
    console.log(`   Estimated questions: ~${estimatedQuestions}`);
    return;
  }

  console.log('\n\n✅ Question generation complete!');
  console.log(`📊 Statistics:`);
  console.log(`   Topics processed:     ${totalAttempted}`);
  console.log(`   Questions generated:  ${totalGenerated}`);

  // Quality metrics summary
  const totalFiltered = aggregateStats.meta_filtered + aggregateStats.type_drift +
    aggregateStats.structural_rejected + aggregateStats.validation_rejected +
    aggregateStats.validation_unmatched + aggregateStats.validation_errors;
  if (totalFiltered > 0 || aggregateStats.difficulty_relabeled > 0) {
    console.log(`   Quality filtering:`);
    if (aggregateStats.meta_filtered > 0) console.log(`     Meta-filtered:      ${aggregateStats.meta_filtered}`);
    if (aggregateStats.type_drift > 0) console.log(`     Type drift:         ${aggregateStats.type_drift}`);
    if (aggregateStats.structural_rejected > 0) console.log(`     Structural rejects: ${aggregateStats.structural_rejected}`);
    if (aggregateStats.validation_rejected > 0) console.log(`     Validation rejects: ${aggregateStats.validation_rejected}`);
    if (aggregateStats.validation_unmatched > 0) console.log(`     Validation unmatched: ${aggregateStats.validation_unmatched}`);
    if (aggregateStats.validation_errors > 0) console.log(`     Validation errors:  ${aggregateStats.validation_errors}`);
    if (aggregateStats.difficulty_relabeled > 0) console.log(`     Difficulty relabeled: ${aggregateStats.difficulty_relabeled}`);
    if (totalGenerated + totalFiltered > 0) {
      const passRate = (totalGenerated / (totalGenerated + totalFiltered) * 100).toFixed(1);
      console.log(`     Validation pass rate: ${passRate}%`);
    }
  }

  if (aggregateUsage.generation.calls + aggregateUsage.validation.calls > 0) {
    const combined = emptyUsageTotals();
    addUsageTotals(combined, aggregateUsage.generation);
    addUsageTotals(combined, aggregateUsage.validation);
    console.log(`\n   Generation: ${formatUsageSummary(aggregateUsage.generation)}`);
    console.log(`   Validation: ${formatUsageSummary(aggregateUsage.validation)}`);
    console.log(`   ${formatUsageSummary(combined)}`);
  }

  if (options.writeDb) {
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
    // Update batch record with final stats
    if (supabaseClient) {
      const validationDenominator = aggregateStats.structural_rejected + aggregateStats.validation_rejected +
        aggregateStats.validation_unmatched + aggregateStats.validation_errors;
      const { error: batchError } = await supabaseClient
        .from('batches')
        .update({
          question_count: totalGenerated,
          inserted_count: totalInserted,
          duplicate_count: totalSkippedDuplicates,
          error_count: zeroQuestionCombos,
          quality_metrics: {
            meta_filtered: aggregateStats.meta_filtered,
            type_drift: aggregateStats.type_drift,
            structural_rejected: aggregateStats.structural_rejected,
            validation_rejected: aggregateStats.validation_rejected,
            validation_unmatched: aggregateStats.validation_unmatched,
            validation_errors: aggregateStats.validation_errors,
            difficulty_relabeled: aggregateStats.difficulty_relabeled,
            validation_pass_rate: totalGenerated + validationDenominator > 0
              ? +(totalGenerated / (totalGenerated + validationDenominator) * 100).toFixed(1)
              : 100,
            llm_usage: {
              generation: aggregateUsage.generation,
              validation: aggregateUsage.validation,
            },
          },
        })
        .eq('id', options.batchId);

      if (batchError) {
        logger.error('Failed to update batch metadata', { message: batchError.message });
        process.exit(1);
      } else {
        console.log(`\n📦 Batch metadata updated: ${options.batchId}`);
      }
    }
  } else {
    console.log('\n⚠️  Questions were generated but NOT saved to database.');
    console.log('   Use --write-db flag to persist questions to Supabase.');
  }
}

async function main() {
  loadEnv();
  const { options } = await bootstrapCommand(cli);
  await generateAllQuestions(options);
}

runIfMain(import.meta.url, main);
