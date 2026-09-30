/**
 * Request-body validation for the student write routes. Bounds are
 * defense against payload-size/DoS abuse and malformed data reaching the
 * database, not a correctness requirement for well-behaved clients.
 */

import { z } from 'zod';
import { DIFFICULTIES } from '@adaptive/shared/enums';

/** Per-quiz question cap, shared with routes outside this schema (e.g. study-guide's
 * incorrect-questions bound) that need the same ceiling without a zod dependency. */
export const MAX_QUESTIONS = 100;
const MAX_ANSWER_LENGTH = 2000;

const difficultySchema = z.enum(DIFFICULTIES);

const questionSummarySchema = z.object({
  id: z.string().min(1).max(200),
  topic: z.string().min(1).max(200),
  difficulty: difficultySchema,
});

const evaluationResultSummarySchema = z.object({
  isCorrect: z.boolean(),
  score: z.number().min(0).max(100).optional(),
});

export const quizResultsSchema = z
  .object({
    unitId: z.string().min(1).max(100),
    difficulty: difficultySchema,
    totalQuestions: z.number().int().min(0).max(MAX_QUESTIONS),
    correctAnswers: z.number().int().min(0).max(MAX_QUESTIONS),
    scorePercentage: z.number().min(0).max(100),
    timeSpentSeconds: z.number().int().min(0).optional(),
    questions: z.array(questionSummarySchema).max(MAX_QUESTIONS),
    userAnswers: z.record(z.string(), z.string().max(MAX_ANSWER_LENGTH)),
    evaluationResults: z.record(z.string(), evaluationResultSummarySchema).optional(),
  })
  .refine((data) => Object.keys(data.userAnswers).length <= MAX_QUESTIONS, {
    message: `userAnswers must not have more than ${MAX_QUESTIONS} entries`,
    path: ['userAnswers'],
  });

export const leitnerUpdateSchema = z.object({
  questionId: z.uuid(),
  isCorrect: z.boolean(),
});

export const evaluateWritingSchema = z.object({
  questionId: z.uuid(),
  userAnswer: z.string().min(1).max(MAX_ANSWER_LENGTH),
});

const MAX_CODE_LENGTH = 200;

export const verifyCodeSchema = z.object({
  code: z.string().max(MAX_CODE_LENGTH).optional(),
  turnstileToken: z.string().max(4000).optional(),
});

export const studyCodePatchSchema = z.object({
  adminLabel: z.string().max(200).optional(),
  wrongAnswerCountdown: z.number().int().min(0).max(3600).nullable().optional(),
  forceLogout: z.boolean().optional(),
});
