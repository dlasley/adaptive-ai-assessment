import { NextRequest, NextResponse } from 'next/server';
import { loadAllQuestions, selectQuestions } from '@/lib/question-loader';
import { getRandomWritingQuestions } from '@/lib/writing-questions';
import { Question } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { unitId, topic, numQuestions, difficulty, includeWriting = true } = body;

    // Validate inputs
    if (!numQuestions) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      );
    }

    // Load all questions from JSON
    let allQuestions = loadAllQuestions();

    // Optionally include writing questions from database
    if (includeWriting) {
      try {
        const writingQuestions = await getRandomWritingQuestions(
          Math.ceil(parseInt(numQuestions) * 0.3), // 30% writing questions
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
