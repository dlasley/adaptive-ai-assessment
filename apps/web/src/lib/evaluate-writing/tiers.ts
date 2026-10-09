import { FEATURES } from '@/lib/feature-flags';
import { fuzzyEvaluateAnswer, normalizeText, normalizePunctuationSpacing, hasCorrectAccents } from '@/lib/typed-answer-evaluation';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import { createLogger } from '@/lib/logger';
import type { EvaluationResult } from './types';

const logger = createLogger('evaluate-writing');
const courseFeedback = COURSE_CONTENT.feedback;

export interface TierContext {
  userAnswer: string;
  correctAnswer: string | undefined;
  difficulty: string;
  acceptableVariations: string[];
  questionType: string;
  includeSuperuserMetadata: boolean;
}

/** Tier 1: reject an empty or too-short answer without any comparison against the correct one. */
function emptyCheckTier(ctx: TierContext): EvaluationResult | null {
  if (ctx.userAnswer.trim().length >= 2) return null;

  const result: EvaluationResult = {
    isCorrect: false,
    score: 0,
    hasCorrectAccents: false,
    feedback: courseFeedback.answerTooShort,
    corrections: {
      suggestions: [courseFeedback.answerTooShortSuggestion]
    }
  };

  if (ctx.includeSuperuserMetadata) {
    result.metadata = {
      difficulty: ctx.difficulty,
      evaluationTier: 'empty_check',
      usedClaudeAPI: false,
      matchedAgainst: 'none',
      evaluationReason: 'Answer too short (less than 2 characters)'
    };
  }

  return result;
}

/** Tier 2: exact match after normalization (including French punctuation spacing and a trailing
 * sentence-ending mark), scored 100 with correct accents or 98 with an accent-only mismatch. */
export function exactMatchTier(ctx: TierContext): EvaluationResult | null {
  const { userAnswer, correctAnswer } = ctx;
  const normalizedUser = normalizePunctuationSpacing(normalizeText(userAnswer));
  const normalizedCorrect = correctAnswer ? normalizePunctuationSpacing(normalizeText(correctAnswer)) : '';

  logger.debug('Tier 2: exact match check', {
    normalizedUser,
    normalizedCorrect,
    matches: normalizedUser === normalizedCorrect
  });

  if (!correctAnswer || normalizedUser !== normalizedCorrect) return null;

  // Check if accents match (case-insensitive), tolerant of punctuation-spacing and
  // terminal-punctuation differences so those never get misreported as an accent mismatch
  const accentsMatch = hasCorrectAccents(userAnswer, correctAnswer);

  const result: EvaluationResult = {
    isCorrect: true,
    score: accentsMatch ? 100 : 98,
    hasCorrectAccents: accentsMatch,
    feedback: accentsMatch
      ? courseFeedback.exactMatchWithAccents
      : courseFeedback.exactMatchMissingAccents,
    corrections: accentsMatch ? {} : {
      accents: [courseFeedback.correctAnswerIs(correctAnswer)]
    }
  };

  if (ctx.includeSuperuserMetadata) {
    result.metadata = {
      difficulty: ctx.difficulty,
      evaluationTier: 'exact_match',
      matchKind: 'exact',
      usedClaudeAPI: false,
      matchedAgainst: 'primary_answer',
      evaluationReason: 'Exact match against primary answer (after normalization)'
    };
  }

  return result;
}

/** Tier 3: accepts an answer that, after normalization, equals an acceptable variation or differs
 * from the correct answer or a variation by one pair of adjacent characters exchanged. Returns null
 * (falls through to Semantic API) for anything else, including when the feature flag disables fuzzy
 * logic or there's no correct answer to compare against. Never grades an answer incorrect. */
export function fuzzyTier(ctx: TierContext): EvaluationResult | null {
  const { userAnswer, correctAnswer, acceptableVariations, difficulty, questionType } = ctx;
  if (FEATURES.SKIP_FUZZY_LOGIC || !correctAnswer) return null;

  const fuzzyResult = fuzzyEvaluateAnswer(
    userAnswer,
    correctAnswer,
    acceptableVariations,
    questionType
  );

  if (!fuzzyResult) {
    logger.debug('Tier 3: no exact or single-swap match, falling through to Semantic API');
    return null;
  }

  // Determine what was matched based on fuzzyResult metadata, then strip the internal field
  // unconditionally: it must never reach a response, superuser or not.
  const matchInfo = fuzzyResult._matchInfo || { matchedAgainst: 'primary_answer', evaluationReason: 'Fuzzy match' };
  delete fuzzyResult._matchInfo;

  if (ctx.includeSuperuserMetadata) {
    fuzzyResult.metadata = {
      difficulty,
      evaluationTier: 'fuzzy_logic',
      matchKind: matchInfo.matchKind,
      usedClaudeAPI: false,
      matchedAgainst: matchInfo.matchedAgainst,
      matchedVariationIndex: matchInfo.matchedVariationIndex,
      evaluationReason: matchInfo.evaluationReason
    };
  }

  return fuzzyResult;
}

/** Answers of at least this many characters are also checked for a high share of symbols. */
const NOISE_RATIO_MIN_LENGTH = 20;
/** Symbols per letter above which a long answer is treated as noise. */
const NOISE_SYMBOL_TO_LETTER_RATIO = 0.5;

/**
 * True for an answer that cannot be prose in the course language: it has no Latin-script letter
 * and no digit (French is written in Latin script, and a numeral such as "15" can be a real
 * answer), or it is long and mostly punctuation, braces and other symbols. Short answers are
 * judged on letters and digits alone so a legitimate "A-t-il ?" is not caught.
 */
export function isNoiseAnswer(answer: string): boolean {
  const letters = answer.match(/[\p{Script=Latin}\p{Nd}]/gu)?.length ?? 0;
  if (letters === 0) return true;
  if (answer.length < NOISE_RATIO_MIN_LENGTH) return false;
  const symbols = answer.match(/[\p{P}\p{S}]/gu)?.length ?? 0;
  return symbols / letters > NOISE_SYMBOL_TO_LETTER_RATIO;
}

/** Tier 3b: grade an answer that is not text in the course language as 0 without a model call. */
export function noiseCheckTier(ctx: TierContext): EvaluationResult | null {
  if (!isNoiseAnswer(ctx.userAnswer)) return null;

  const result: EvaluationResult = {
    isCorrect: false,
    score: 0,
    hasCorrectAccents: false,
    feedback: courseFeedback.answerTooShort,
    corrections: {
      suggestions: [courseFeedback.answerTooShortSuggestion]
    }
  };

  if (ctx.includeSuperuserMetadata) {
    result.metadata = {
      difficulty: ctx.difficulty,
      evaluationTier: 'noise_check',
      usedClaudeAPI: false,
      matchedAgainst: 'none',
      evaluationReason: 'Answer has no letters or digits or is mostly symbols; not sent to the model'
    };
  }

  return result;
}

/** Tiers 1-3b, in the order the route tries them before falling back to the Semantic API (tier 4,
 * `model-grading.ts`). Named so `logOutcome` can record which one resolved a request. */
export const EVALUATION_TIERS: { name: 'empty_check' | 'exact_match' | 'fuzzy_logic' | 'noise_check'; run: (ctx: TierContext) => EvaluationResult | null }[] = [
  { name: 'empty_check', run: emptyCheckTier },
  { name: 'exact_match', run: exactMatchTier },
  { name: 'fuzzy_logic', run: fuzzyTier },
  { name: 'noise_check', run: noiseCheckTier },
];
