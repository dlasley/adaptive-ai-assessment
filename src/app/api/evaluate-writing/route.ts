import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { FEATURES, getFuzzyLogicThreshold, CORRECTNESS_THRESHOLDS } from '@/lib/feature-flags';
import { fuzzyEvaluateAnswer, calculateSimilarity, normalizeText, normalizePunctuationSpacing } from '@/lib/writing-questions';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';
import { checkRateLimit, getClientIp } from '@/lib/rate-limiter';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Check if a study code ID belongs to a superuser
 */
async function isSuperuser(studyCodeId: string | undefined): Promise<boolean> {
  if (!studyCodeId || !isSupabaseAvailable()) {
    return false;
  }

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('is_superuser')
      .eq('id', studyCodeId)
      .single();

    if (error || !data) {
      return false;
    }

    return data.is_superuser === true;
  } catch (error) {
    console.error('Error checking superuser status:', error);
    return false;
  }
}

export interface EvaluationResult {
  isCorrect: boolean;
  score: number; // 0-100
  hasCorrectAccents: boolean;
  feedback: string;
  corrections: {
    grammar?: string[];
    spelling?: string[];
    accents?: string[];
    suggestions?: string[];
  };
  correctedAnswer?: string;
  // Internal field for passing match info from fuzzy evaluation (removed before sending response)
  _matchInfo?: {
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number;
    matchedSimilarity?: number; // 0-100, similarity to the matched answer (not necessarily primary)
    evaluationReason: string;
    correctnessBand?: string; // Which correctness band this fell into (e.g., "95%+ (minor typo)")
  };
  // Superuser metadata (only included when is_superuser=true)
  metadata?: {
    difficulty: string;
    evaluationTier: 'empty_check' | 'exact_match' | 'fuzzy_logic' | 'claude_api';
    levenshteinSimilarity?: number; // 0-100, similarity score from Levenshtein distance
    levenshteinThreshold?: number; // 0-100, threshold for this difficulty
    claudeConfidence?: number; // 0-100, Claude's self-reported confidence (only for claude_api tier)
    usedClaudeAPI: boolean;
    modelUsed?: string;
    matchedAgainst: 'primary_answer' | 'acceptable_variation' | 'none';
    matchedVariationIndex?: number; // Which variation was matched (0-indexed)
    evaluationReason: string; // Human-readable explanation of why this tier was used
    correctnessBand?: string; // Which correctness band this fell into (for fuzzy_logic tier)
  };
}

// Rate limit: 15 requests per minute per IP
const EVALUATE_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 15 };

export async function POST(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rateLimitResult = checkRateLimit(`evaluate:${clientIp}`, EVALUATE_RATE_LIMIT);

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
    const {
      question,
      userAnswer,
      correctAnswer,
      questionType,
      difficulty,
      acceptableVariations = [],
      studyCodeId,
      superuserOverride  // Optional override from client (URL param -> sessionStorage)
    } = await request.json();

    console.log(`📝 Evaluating ${questionType} question:`, {
      question: question.substring(0, 50),
      userAnswer: userAnswer.substring(0, 50),
      correctAnswer: correctAnswer?.substring(0, 50),
      difficulty,
      hasStudyCodeId: !!studyCodeId,
      superuserOverride
    });

    if (!question || !userAnswer) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Check if user is a superuser (for metadata)
    // Priority: explicit override > database status
    let includeSuperuserMetadata: boolean;
    if (superuserOverride !== undefined && superuserOverride !== null) {
      includeSuperuserMetadata = superuserOverride === true;
      console.log(`🔬 Superuser metadata (OVERRIDE): ${includeSuperuserMetadata}`);
    } else {
      includeSuperuserMetadata = await isSuperuser(studyCodeId);
      console.log(`🔬 Superuser metadata (DB): ${includeSuperuserMetadata}`);
    }

    // Tier 1: Check if answer is empty or too short
    if (userAnswer.trim().length < 2) {
      console.log('⚠️  Tier 1: Empty check - answer too short');
      const result: EvaluationResult = {
        isCorrect: false,
        score: 0,
        hasCorrectAccents: false,
        feedback: 'Réponse trop courte. Veuillez fournir une réponse complète.',
        corrections: {
          suggestions: ['Essayez d\'écrire une réponse complète en français.']
        }
      };

      if (includeSuperuserMetadata) {
        result.metadata = {
          difficulty,
          evaluationTier: 'empty_check',
          usedClaudeAPI: false,
          matchedAgainst: 'none',
          evaluationReason: 'Answer too short (less than 2 characters)'
        };
      }

      return NextResponse.json<EvaluationResult>(result);
    }

    // Tier 2: Exact match (with normalization, including French punctuation spacing)
    const normalizedUser = normalizePunctuationSpacing(normalizeText(userAnswer));
    const normalizedCorrect = correctAnswer ? normalizePunctuationSpacing(normalizeText(correctAnswer)) : '';

    console.log('🔍 Tier 2: Exact match check:', {
      normalizedUser,
      normalizedCorrect,
      matches: normalizedUser === normalizedCorrect
    });

    if (correctAnswer && normalizedUser === normalizedCorrect) {
      console.log('✅ Tier 2: Exact match found');
      // Check if accents match (case-insensitive)
      // Only check for diacritical marks, not capitalization
      const hasCorrectAccents = normalizePunctuationSpacing(userAnswer.trim().toLowerCase()) === normalizePunctuationSpacing(correctAnswer.trim().toLowerCase());

      const result: EvaluationResult = {
        isCorrect: true,
        score: hasCorrectAccents ? 100 : 98,
        hasCorrectAccents,
        feedback: hasCorrectAccents
          ? 'Parfait ! Réponse correcte avec les accents appropriés.'
          : 'Correct ! Attention aux accents pour être parfait.',
        corrections: hasCorrectAccents ? {} : {
          accents: [`La réponse correcte est: "${correctAnswer}"`]
        }
      };

      if (includeSuperuserMetadata) {
        const similarity = calculateSimilarity(userAnswer, correctAnswer);
        result.metadata = {
          difficulty,
          evaluationTier: 'exact_match',
          levenshteinSimilarity: Math.round(similarity * 100),
          usedClaudeAPI: false,
          matchedAgainst: 'primary_answer',
          evaluationReason: 'Exact match against primary answer (after normalization)'
        };
      }

      return NextResponse.json<EvaluationResult>(result);
    }

    // Tier 3: Fuzzy evaluation (if feature flag enabled and confidence is high enough)
    console.log('🔧 Tier 3: Fuzzy logic check:', {
      featureFlagEnabled: !FEATURES.SKIP_FUZZY_LOGIC,
      hasCorrectAnswer: !!correctAnswer
    });

    if (!FEATURES.SKIP_FUZZY_LOGIC && correctAnswer) {
      const similarity = calculateSimilarity(userAnswer, correctAnswer);
      const confidenceScore = Math.round(similarity * 100);

      // Get fuzzy logic threshold for this difficulty
      const threshold = getFuzzyLogicThreshold(difficulty);

      console.log('🔧 Fuzzy logic similarity:', {
        similarity: confidenceScore,
        threshold,
        meetsThreshold: confidenceScore >= threshold
      });

      const fuzzyResult = fuzzyEvaluateAnswer(
        userAnswer,
        correctAnswer,
        acceptableVariations,
        difficulty as 'beginner' | 'intermediate' | 'advanced',
        questionType
      );

      // If fuzzy evaluation succeeded with high confidence, use it
      if (fuzzyResult) {
        console.log('✅ Tier 3: Fuzzy logic evaluation succeeded');
        if (includeSuperuserMetadata) {
          // Determine what was matched based on fuzzyResult metadata
          const matchInfo = fuzzyResult._matchInfo || { matchedAgainst: 'primary_answer', evaluationReason: 'Fuzzy match' };
          delete fuzzyResult._matchInfo; // Remove internal field before sending response

          // Use the similarity to the matched answer, not the primary answer
          const displaySimilarity = matchInfo.matchedSimilarity ?? confidenceScore;

          fuzzyResult.metadata = {
            difficulty,
            evaluationTier: 'fuzzy_logic',
            levenshteinSimilarity: displaySimilarity,
            levenshteinThreshold: threshold,
            usedClaudeAPI: false,
            matchedAgainst: matchInfo.matchedAgainst,
            matchedVariationIndex: matchInfo.matchedVariationIndex,
            evaluationReason: matchInfo.evaluationReason,
            correctnessBand: matchInfo.correctnessBand
          };
        }
        return NextResponse.json<EvaluationResult>(fuzzyResult);
      }

      // Otherwise, fall through to Semantic API evaluation
      console.log('⚠️  Tier 3: Fuzzy evaluation confidence too low, using Semantic API');
    }

    // Tier 4: AI Evaluation with Opus 4.5 (for accuracy or as fallback)
    console.log('🤖 Tier 4: Using Semantic API evaluation');
    const { evaluation, claudeConfidence } = await evaluateWithClaude(
      question,
      userAnswer,
      correctAnswer,
      questionType,
      difficulty
    );

    console.log('✅ Tier 4: Semantic API evaluation completed:', {
      isCorrect: evaluation.isCorrect,
      score: evaluation.score,
      confidence: claudeConfidence
    });

    if (includeSuperuserMetadata) {
      const similarity = correctAnswer ? calculateSimilarity(userAnswer, correctAnswer) : undefined;
      evaluation.metadata = {
        difficulty,
        evaluationTier: 'claude_api',
        levenshteinSimilarity: similarity !== undefined ? Math.round(similarity * 100) : undefined,
        claudeConfidence, // Claude's self-reported confidence
        usedClaudeAPI: true,
        modelUsed: 'claude-opus-4-5-20251101',
        matchedAgainst: 'none', // Claude evaluates semantically, not by matching
        evaluationReason: 'Fuzzy logic confidence below threshold; used Semantic API for semantic evaluation'
      };
    }

    return NextResponse.json<EvaluationResult>(evaluation);
  } catch (error) {
    console.error('❌ Error evaluating answer:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    return NextResponse.json(
      { error: 'Failed to evaluate answer' },
      { status: 500 }
    );
  }
}

/**
 * Semantic API response interface (includes confidence score)
 */
interface ClaudeEvaluationResponse {
  isCorrect: boolean;
  score: number;
  hasCorrectAccents: boolean;
  feedback: string;
  corrections: {
    grammar?: string[];
    spelling?: string[];
    accents?: string[];
    suggestions?: string[];
  };
  correctedAnswer?: string;
  confidenceScore?: number; // Claude's self-reported confidence
}

/**
 * Evaluate answer using Claude Opus 4.5
 * Returns both the evaluation result and Claude's confidence score
 */
async function evaluateWithClaude(
  question: string,
  userAnswer: string,
  correctAnswer: string | undefined,
  questionType: string,
  difficulty: string
): Promise<{ evaluation: EvaluationResult; claudeConfidence?: number }> {
  const prompt = `You are evaluating a French language student's written answer. Be thorough and pedagogical.

Question Type: ${questionType}
Difficulty Level: ${difficulty}
Question (English): "${question}"
${correctAnswer ? `Expected Answer: "${correctAnswer}"` : 'This is an open-ended question with multiple acceptable answers.'}
Student's Answer: "${userAnswer}"

Evaluate the student's answer considering:

1. **Correctness**: Is the meaning/content correct?
2. **Grammar**: Are grammar rules followed correctly?
3. **Spelling**: Are words spelled correctly (ignoring accents for now)?
4. **Accents**: Are diacritic accents used correctly? (café, été, où, etc.)
5. **Completeness**: ${questionType === 'open_ended' ? 'Is it a complete, coherent sentence/response?' : 'Does it answer the question fully?'}
6. **French Typography**: In traditional French, a space before double punctuation marks (?, !, ;, :) is correct (e.g., "français ?"). Accept BOTH forms — with or without the space. Do NOT mark the spaced version as incorrect or provide a "correctedAnswer" that removes it. Occasionally note the cultural difference in your feedback: if the student includes the space, acknowledge it positively as proper traditional French formatting; if they omit it, mention that in traditional French typography a space before ?, !, ;, : is standard — it's a good opportunity to highlight how punctuation conventions differ between metropolitan French and global French-speaking cultures.

For open-ended questions:
- Accept any grammatically correct and contextually appropriate answer
- The student's creativity should be valued
- Focus on whether they expressed their idea correctly in French

Scoring Guidelines:
- 90-100: Excellent, nearly perfect or perfect
- 80-89: Very good, minor errors
- 70-79: Good, some errors but meaning is clear
- 60-69: Acceptable, multiple errors but partially correct
- 50-59: Poor, significant errors but some correct elements
- 0-49: Incorrect or unintelligible

Confidence Assessment:
Also provide a confidence score (0-100) indicating how certain you are about this evaluation:
- 95-100: Very confident - clear-cut correct/incorrect, no ambiguity
- 85-94: Confident - standard case with clear grammar rules
- 75-84: Moderately confident - some interpretation needed
- 60-74: Uncertain - multiple valid interpretations possible
- Below 60: Low confidence - highly ambiguous or creative answer

Return ONLY a valid JSON object with this exact structure (no markdown, no code blocks):
{
  "isCorrect": boolean (true if score >= ${CORRECTNESS_THRESHOLDS.CLAUDE_API_PASS}),
  "score": number (0-100),
  "hasCorrectAccents": boolean,
  "feedback": "Brief, encouraging feedback in English (2-3 sentences)",
  "corrections": {
    "grammar": ["list of grammar corrections if needed"],
    "spelling": ["list of spelling corrections if needed"],
    "accents": ["list of words needing correct accents"],
    "suggestions": ["suggestions for improvement"]
  },
  "correctedAnswer": "The fully corrected version of their answer, or null if already perfect",
  "confidenceScore": number (0-100, your confidence in this evaluation)
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6', // Best model for accuracy
      max_tokens: 1024,
      temperature: 0.3, // Lower temperature for consistent evaluation
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const textContent = response.content[0];
    if (textContent.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    // Parse the JSON response
    const claudeResponse = JSON.parse(textContent.text) as ClaudeEvaluationResponse;

    // Extract confidence score and remove it from the evaluation result
    const { confidenceScore, ...evaluationResult } = claudeResponse;

    return {
      evaluation: evaluationResult as EvaluationResult,
      claudeConfidence: confidenceScore
    };
  } catch (error) {
    console.error('Semantic API error:', error);

    // Fallback evaluation
    return {
      evaluation: {
        isCorrect: false,
        score: 50,
        hasCorrectAccents: false,
        feedback: 'Unable to evaluate automatically. Please try again or ask your teacher for feedback.',
        corrections: {}
      },
      claudeConfidence: undefined
    };
  }
}
