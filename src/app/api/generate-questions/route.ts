import { NextRequest, NextResponse } from 'next/server';
import { loadAllQuestions, selectQuestions } from '@/lib/question-loader';
import { getRandomWritingQuestions } from '@/lib/writing-questions';
import { getModeConfig, QuizMode } from '@/lib/quiz-modes';
import { Question } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      unitId,
      topic,
      numQuestions,
      difficulty,
      mode = 'practice' as QuizMode,
      includeWriting = true
    } = body;

    // Validate inputs
    if (!numQuestions) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    // Get mode configuration
    const modeConfig = getModeConfig(mode);
    console.log(`🎮 Quiz mode: ${modeConfig.label}`);

    // Load all questions from JSON
    let allQuestions = loadAllQuestions();

    // Optionally include writing questions from database
    // Only fetch if writing is allowed in the mode
    const shouldIncludeWriting = includeWriting && modeConfig.allowedTypes.includes('writing');
    if (shouldIncludeWriting) {
      try {
        // For assessment mode, fetch more writing questions (50% instead of 30%)
        const writingRatio = modeConfig.typeDistribution['writing'] || 0.3;
        const writingQuestions = await getRandomWritingQuestions(
          Math.ceil(parseInt(numQuestions) * writingRatio),
          difficulty as 'beginner' | 'intermediate' | 'advanced' | undefined
        );

        console.log(`📝 Fetched ${writingQuestions.length} writing questions for difficulty: ${difficulty}`);

        if (writingQuestions.length > 0) {
          // Convert writing questions to Question format
          const convertedWritingQuestions: Question[] = writingQuestions.map(wq => ({
            id: wq.id,
            question: wq.question_en,
            type: 'writing' as const,
            correctAnswer: wq.correct_answer_fr || '',
            explanation: wq.explanation,
            unitId: wq.unit_id || 'all',
            topic: wq.topic,
            difficulty: wq.difficulty,
            writingType: wq.question_type,
            acceptableVariations: wq.acceptable_variations,
            hints: wq.hints,
            requiresCompleteSentence: wq.requires_complete_sentence
          }));

          // Merge writing questions with standard questions
          allQuestions = [...allQuestions, ...convertedWritingQuestions];
          console.log(`✅ Added ${convertedWritingQuestions.length} writing questions to pool`);
        } else {
          console.log(`⚠️  No writing questions found for difficulty: ${difficulty}`);
        }
      } catch (error) {
        console.error('❌ Error loading writing questions:', error);
        // Continue without writing questions
      }
    }

    if (allQuestions.length === 0) {
      return NextResponse.json(
        {
          error: 'No questions available',
          details: 'Please run "npm run generate-questions" to create the question bank'
        },
        { status: 500 }
      );
    }

    // Select questions based on criteria and mode
    const result = selectQuestions(allQuestions, {
      unitId: unitId || 'all',
      topic,
      difficulty,
      numQuestions: parseInt(numQuestions),
      allowedTypes: modeConfig.allowedTypes,
      typeDistribution: modeConfig.typeDistribution,
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
    console.error('Error loading questions:', error);
    return NextResponse.json(
      {
        error: 'Failed to load questions',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
