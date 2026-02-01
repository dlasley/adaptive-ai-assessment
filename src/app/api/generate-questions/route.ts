import { NextRequest, NextResponse } from 'next/server';
import { loadAllQuestions, selectQuestions } from '@/lib/question-loader';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { unitId, topic, numQuestions, difficulty } = body;

    // Validate inputs
    if (!numQuestions) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    // Load all questions from JSON
    const allQuestions = loadAllQuestions();

    if (allQuestions.length === 0) {
      return NextResponse.json(
        {
          error: 'No questions available',
          details: 'Please run "npm run generate-questions" to create the question bank'
        },
        { status: 500 }
      );
    }

    // Select questions based on criteria
    const questions = selectQuestions(allQuestions, {
      unitId: unitId || 'all',
      topic,
      difficulty,
      numQuestions: parseInt(numQuestions),
    });

    if (questions.length === 0) {
      return NextResponse.json(
        {
          error: 'No matching questions found',
          details: `No questions found for the selected criteria. Try different filters.`
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ questions });
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
