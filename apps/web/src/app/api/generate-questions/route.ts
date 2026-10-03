import { NextRequest, NextResponse } from 'next/server';
import { loadAllQuestions, selectQuestions } from '@/lib/question-loader';
import { getModeConfig } from '@/lib/quiz-modes';
import { generateQuestionsSchema } from '@/lib/api-schemas';
import { verifyCsrfProtection } from '@/lib/csrf';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';
import { FEATURES } from '@/lib/feature-flags';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { requireStudentSession } from '@/lib/student-api-guard';
import { readStudentSessionToken, verifyStudentSessionToken } from '@/lib/student-session';
import { tooManyRequestsResponse } from '@/lib/rate-limit-response';
import { createLogger } from '@/lib/logger';
import { supabaseErrorFields } from '@/lib/supabase-error';

const logger = createLogger('generate-questions');

// Each request reads the whole question bank. A session (or, with none, an IP) gets a small budget;
// the per-IP backstop is sized so a classroom behind one address fits under it.
const GENERATE_SESSION_LIMIT = { windowMs: 60 * 1000, maxRequests: 10 };
const GENERATE_IP_BACKSTOP = { windowMs: 60 * 1000, maxRequests: 120 };
const RATE_LIMITED_MESSAGE = 'Too many requests. Please wait before trying again.';

export async function POST(request: NextRequest) {
  const csrfError = verifyCsrfProtection(request);
  if (csrfError) return csrfError;

  const ip = getClientIp(request);
  const ipLimit = await checkRateLimit(`generate-questions-ip:${ip}`, GENERATE_IP_BACKSTOP);
  if (!ipLimit.allowed) return tooManyRequestsResponse(RATE_LIMITED_MESSAGE, ipLimit.resetAt);

  // Signature and expiry only: a rate-limit key needs no database round trip.
  const sessionId = verifyStudentSessionToken(readStudentSessionToken(request))?.studyCodeId;
  const callerKey = sessionId ? `session:${sessionId}` : `anon:${ip}`;
  const callerLimit = await checkRateLimit(`generate-questions:${callerKey}`, GENERATE_SESSION_LIMIT);
  if (!callerLimit.allowed) return tooManyRequestsResponse(RATE_LIMITED_MESSAGE, callerLimit.resetAt);

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const parsed = generateQuestionsSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { unitId, topic, numQuestions, difficulty, mode, leitnerMode } = parsed.data;

    // Leitner weighting is scoped to the caller's own session. A request with no valid session
    // skips adaptive weighting rather than failing the whole route, since most quiz generation
    // is not adaptive.
    const session = leitnerMode ? await requireStudentSession(request) : null;
    const studyCodeId = session && !(session instanceof NextResponse) ? session.studyCodeId : null;

    // Get mode configuration
    const modeConfig = getModeConfig(mode);
    logger.debug(`Quiz mode: ${modeConfig.label}`);

    // Load all questions from database (unified questions table)
    const allQuestions = await loadAllQuestions();

    logger.debug(`Loaded ${allQuestions.length} questions from database`);

    if (allQuestions.length === 0) {
      return NextResponse.json(
        { error: 'No questions available' },
        { status: 500 }
      );
    }

    // Load Leitner state for weighted selection if adaptive mode is active
    let leitnerWeights: Map<string, number> | undefined;
    if (leitnerMode && studyCodeId && FEATURES.LEITNER_MODE) {
      const { data, error } = await supabaseAdmin!
        .from('leitner_state')
        .select('question_id, box')
        .eq('study_code_id', studyCodeId);

      if (!error && data) {
        leitnerWeights = new Map(data.map((r) => [r.question_id, r.box as number]));
        logger.debug(`Leitner: loaded ${leitnerWeights.size} question states for adaptive selection`);
      }
    }

    // Select questions based on criteria and mode
    const result = selectQuestions(allQuestions, {
      unitId: unitId || 'all',
      topic,
      difficulty,
      numQuestions,
      allowedTypes: modeConfig.allowedTypes,
      typeDistribution: modeConfig.typeDistribution,
      leitnerWeights,
    });

    if (result.questions.length === 0) {
      return NextResponse.json(
        {
          error: 'No matching questions found',
          details: `No questions found for the selected criteria. Try different filters.`
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      questions: result.questions,
      warnings: result.warnings,
      requestedCount: result.requestedCount,
      actualCount: result.actualCount,
      mode: mode,
    });
  } catch (error) {
    logger.error('Error loading questions', supabaseErrorFields(error));
    return NextResponse.json(
      { error: 'Failed to load questions' },
      { status: 500 }
    );
  }
}
