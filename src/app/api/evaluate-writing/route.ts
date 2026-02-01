import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { FEATURES } from '@/lib/feature-flags';
import { fuzzyEvaluateAnswer, calculateSimilarity } from '@/lib/writing-questions';
import { supabase, isSupabaseAvailable } from '@/lib/supabase';

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
  // Superuser metadata (only included when is_superuser=true)
  metadata?: {
    difficulty: string;
    evaluationTier: 'empty_check' | 'exact_match' | 'fuzzy_logic' | 'claude_api';
    similarityScore?: number; // 0-100
    confidenceScore?: number; // 0-100
    confidenceThreshold?: number; // 0-100
    usedClaudeAPI: boolean;
    modelUsed?: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const {
      question,
      userAnswer,
      correctAnswer,
      questionType,
      difficulty,
      acceptableVariations = [],
      studyCodeId
    } = await request.json();

    if (!question || !userAnswer) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Check if user is a superuser (for metadata)
    const includeSuperuserMetadata = await isSuperuser(studyCodeId);

    // Tier 1: Check if answer is empty or too short
    if (userAnswer.trim().length < 2) {
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
          usedClaudeAPI: false
        };
      }

      return NextResponse.json<EvaluationResult>(result);
    }

    // Tier 2: Exact match (with normalization)
    const normalizedUser = normalizeText(userAnswer);
    const normalizedCorrect = correctAnswer ? normalizeText(correctAnswer) : '';

    if (correctAnswer && normalizedUser === normalizedCorrect) {
      // Check if accents match (case-insensitive)
      // Only check for diacritical marks, not capitalization
      const hasCorrectAccents = userAnswer.trim().toLowerCase() === correctAnswer.trim().toLowerCase();

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
          similarityScore: Math.round(similarity * 100),
          confidenceScore: 100,
          usedClaudeAPI: false
        };
      }

      return NextResponse.json<EvaluationResult>(result);
    }

    // Tier 3: Fuzzy evaluation (if feature flag enabled and confidence is high enough)
    if (!FEATURES.API_ONLY_EVALUATION && correctAnswer) {
      const similarity = calculateSimilarity(userAnswer, correctAnswer);
      const confidenceScore = Math.round(similarity * 100);

      // Get confidence threshold for this difficulty
      const thresholds = { beginner: 70, intermediate: 85, advanced: 95 };
      const threshold = thresholds[difficulty as keyof typeof thresholds] || 85;

      const fuzzyResult = fuzzyEvaluateAnswer(
        userAnswer,
        correctAnswer,
        acceptableVariations,
        difficulty as 'beginner' | 'intermediate' | 'advanced',
        questionType
      );

      // If fuzzy evaluation succeeded with high confidence, use it
      if (fuzzyResult) {
        if (includeSuperuserMetadata) {
          fuzzyResult.metadata = {
            difficulty,
            evaluationTier: 'fuzzy_logic',
            similarityScore: confidenceScore,
            confidenceScore,
            confidenceThreshold: threshold,
            usedClaudeAPI: false
          };
        }
        return NextResponse.json<EvaluationResult>(fuzzyResult);
      }

      // Otherwise, fall through to Claude API evaluation
      console.log('Fuzzy evaluation confidence too low, using Claude API');
    }

    // Tier 4: AI Evaluation with Opus 4.5 (for accuracy or as fallback)
    const { evaluation, claudeConfidence } = await evaluateWithClaude(
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
        similarityScore: similarity !== undefined ? Math.round(similarity * 100) : undefined,
        confidenceScore: claudeConfidence, // Claude's self-reported confidence
        usedClaudeAPI: true,
        modelUsed: 'claude-opus-4-5-20251101'
      };
    }

    return NextResponse.json<EvaluationResult>(evaluation);
  } catch (error) {
    console.error('Error evaluating answer:', error);
    return NextResponse.json(
      { error: 'Failed to evaluate answer' },
      { status: 500 }
    );
  }
}

/**
 * Normalize text by removing accents and converting to lowercase
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' '); // Normalize whitespace
}

/**
 * Claude API response interface (includes confidence score)
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
  "isCorrect": boolean (true if score >= 70),
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
      model: 'claude-opus-4-5-20251101', // Best model for accuracy
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
    console.error('Claude API error:', error);

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
