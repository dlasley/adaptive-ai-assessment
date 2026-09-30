import { NextRequest, NextResponse } from 'next/server';
import { FEATURES } from '@/lib/feature-flags';
import { calculateSimilarity } from '@/lib/typed-answer-evaluation';
import { MODELS } from '@adaptive/shared/models';
import { loadQuestionsByIds } from '@/lib/question-loader';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';
import { requireStudentSession } from '@/lib/student-api-guard';
import { verifyCsrfProtection } from '@/lib/csrf';
import { evaluateWritingSchema } from '@/lib/api-schemas';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';
import { isSuperuser } from '@/lib/evaluate-writing/superuser-check';
import { EVALUATION_TIERS, type TierContext } from '@/lib/evaluate-writing/tiers';
import { evaluateWithModel, type GradingCallUsage } from '@/lib/evaluate-writing/model-grading';
import type { EvaluationResult } from '@/lib/evaluate-writing/types';

const logger = createLogger('evaluate-writing');

// Opus 5.5 reasons unconditionally (it rejects disableReasoning) and a retry can issue a second
// sequential call — explicit budget for two reasoning + jsonMode calls rather than relying on
// Vercel Fluid Compute's higher default.
export const maxDuration = 60;

// Rate limit: 15 requests per minute per IP
const EVALUATE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 15 };

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const session = await requireStudentSession(request);
  if (session instanceof NextResponse) return session;

  const clientIp = getClientIp(request);
  const rateLimitResult = await checkRateLimit(`evaluate:${clientIp}`, EVALUATE_RATE_LIMIT);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait before submitting again.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const parsed = evaluateWritingSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { questionId, userAnswer } = parsed.data;

    const questionMap = await loadQuestionsByIds([questionId]);
    const dbQuestion = questionMap.get(questionId);
    if (!dbQuestion) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404 });
    }

    // Grading inputs come from the stored question, never the request body —
    // a client that could supply its own correctAnswer/difficulty/acceptableVariations could
    // force any answer to grade as correct.
    const question = dbQuestion.question;
    const correctAnswer = dbQuestion.correctAnswer;
    const difficulty = dbQuestion.difficulty;
    const acceptableVariations = dbQuestion.acceptableVariations ?? [];
    // Mirrors the type derivation the quiz UI uses to choose a grading strategy
    // (fill-in-blank vs. a writing sub-type).
    const questionType = dbQuestion.type === 'fill-in-blank' ? 'fill_in_blank' : (dbQuestion.writingType || 'translation');

    const startedAt = Date.now();

    // Debug-only: includes truncated student-authored text, so it never reaches any Vercel-deployed
    // build (production or preview, which shares the production database) — see src/lib/logger.ts's
    // environment gating.
    logger.debug(`Evaluating ${questionType} question`, {
      question: question.substring(0, 50),
      userAnswer: userAnswer.substring(0, 50),
      correctAnswer: correctAnswer.substring(0, 50),
      difficulty,
    });

    // The only per-request record that reaches production logs: tier, correctness, latency, and
    // (for the model tier) cost/token accounting — never student-authored text or identifiers.
    const logOutcome = (tier: string, isCorrect: boolean, score: number, meta?: { parseFailure?: boolean; usage?: GradingCallUsage }): void => {
      logger.info('Evaluation complete', {
        tier,
        isCorrect,
        score,
        questionType,
        difficulty,
        durationMs: Date.now() - startedAt,
        ...(meta?.parseFailure ? { parse_failure: true } : {}),
        ...(meta?.usage?.costUsd !== undefined ? { cost_usd: meta.usage.costUsd } : {}),
        ...(meta?.usage?.servedModel !== undefined ? { served_model: meta.usage.servedModel } : {}),
        ...(meta?.usage?.promptTokens !== undefined ? { prompt_tokens: meta.usage.promptTokens } : {}),
        ...(meta?.usage?.completionTokens !== undefined ? { completion_tokens: meta.usage.completionTokens } : {}),
        ...(meta?.usage?.error ? { error: true } : {}),
      });
    };

    // Superuser metadata is resolved exclusively from the session's
    // DB-backed is_superuser flag — no client-supplied override.
    const includeSuperuserMetadata = await isSuperuser(session.studyCodeId);

    // Tiers 1-3: empty check, exact match, fuzzy match — each returns null to fall through to the
    // next tier, ending with the Semantic API (tier 4) below if none of them resolve the answer.
    const tierContext: TierContext = {
      userAnswer,
      correctAnswer,
      difficulty,
      acceptableVariations,
      questionType,
      includeSuperuserMetadata,
    };
    for (const tier of EVALUATION_TIERS) {
      const result = tier.run(tierContext);
      if (result) {
        logOutcome(tier.name, result.isCorrect, result.score);
        return NextResponse.json<EvaluationResult>(result);
      }
    }

    // Tier 4: AI Evaluation with the configured writing-evaluation model (for accuracy or as fallback)
    const { evaluation, modelConfidence, parseFailure, usage } = await evaluateWithModel(
      question,
      userAnswer,
      correctAnswer,
      questionType,
      difficulty
    );

    if (includeSuperuserMetadata) {
      const similarity = correctAnswer ? calculateSimilarity(userAnswer, correctAnswer) : undefined;
      evaluation.metadata = {
        difficulty,
        evaluationTier: 'claude_api',
        levenshteinSimilarity: similarity !== undefined ? Math.round(similarity * 100) : undefined,
        modelConfidence, // the model's self-reported confidence
        usedClaudeAPI: true,
        modelUsed: MODELS.writingEvaluation,
        matchedAgainst: 'none', // the model evaluates semantically, not by matching
        evaluationReason: FEATURES.SKIP_FUZZY_LOGIC
          ? 'Fuzzy logic disabled by SKIP_FUZZY_LOGIC; used Semantic API for semantic evaluation'
          : 'Fuzzy logic confidence below threshold; used Semantic API for semantic evaluation'
      };
    }

    logOutcome('claude_api', evaluation.isCorrect, evaluation.score, { parseFailure, usage });
    return NextResponse.json<EvaluationResult>(evaluation);
  } catch (error) {
    logger.error('Error evaluating answer', supabaseErrorFields(error));
    return NextResponse.json(
      { error: 'Failed to evaluate answer' },
      { status: 500 }
    );
  }
}
