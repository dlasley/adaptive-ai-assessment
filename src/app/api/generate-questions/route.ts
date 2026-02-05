import { NextRequest, NextResponse } from 'next/server';
import { loadAllQuestions, selectQuestions } from '@/lib/question-loader';
import { getModeConfig, QuizMode } from '@/lib/quiz-modes';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      unitId,
      topic,
      numQuestions,
      difficulty,
      mode = 'practice' as QuizMode,
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

    // Load all questions from database (unified questions table)
    const allQuestions = await loadAllQuestions();

    console.log(`📚 Loaded ${allQuestions.length} questions from database`);

    if (allQuestions.length === 0) {
      return NextResponse.json(
        {
          error: 'No questions available',
          details: 'Please run "npm run generate-questions --sync-db" to populate the question bank'
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
