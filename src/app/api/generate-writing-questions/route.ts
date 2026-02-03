import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export interface WritingQuestion {
  question_en: string;
  correct_answer_fr: string | null;
  acceptable_variations: string[];
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  question_type: 'translation' | 'conjugation' | 'open_ended' | 'question_formation' | 'sentence_building';
  explanation: string;
  hints: string[];
  requires_complete_sentence: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const { count = 20, difficulty, topic, unitId } = await request.json();

    const questions = await generateQuestions(count, difficulty, topic, unitId);

    return NextResponse.json({ questions, count: questions.length });
  } catch (error) {
    console.error('Error generating questions:', error);
    return NextResponse.json(
      { error: 'Failed to generate questions' },
      { status: 500 }
    );
  }
}

async function generateQuestions(
  count: number,
  difficulty?: string,
  topic?: string,
  unitId?: string
): Promise<WritingQuestion[]> {
  const prompt = `Generate ${count} French writing practice questions for students.

Requirements:
- Mix of difficulty levels: ${difficulty || 'beginner (30%), intermediate (40%), advanced (30%)'}
- ${topic ? `Focus on topic: ${topic}` : 'Diverse topics covering everyday conversation, grammar, and cultural contexts'}
- ${unitId ? `Align with curriculum unit: ${unitId}` : 'General French language practice'}

Question Types to Include:
1. **Simple Translation** (beginner): "How do you say 'X' in French?"
2. **Verb Conjugation** (beginner/intermediate): "Conjugate 'verb' in tense, person"
3. **Sentence Translation** (intermediate): "Translate: [English sentence]"
4. **Open-Ended Personal** (intermediate/advanced): "What are you going to do this weekend?" - requires creative, complete sentence response
5. **Question Formation** (intermediate): "How do you ask 'X' in French?"
6. **Descriptive Writing** (advanced): "Describe your favorite place in 2-3 sentences"
7. **Opinion Expression** (advanced): "What do you think about...? Explain in French."

IMPORTANT for Advanced Questions:
- Include many open-ended questions requiring complete sentence responses
- Accept multiple correct answers (students' creativity should be valued)
- Questions should prompt natural, conversational French
- Examples:
  * "What did you do last weekend?" → Any grammatically correct past-tense response
  * "What are your plans for summer?" → Any future-tense response about plans
  * "Describe your best friend" → Any descriptive response

For each question, provide:
- question_en: The English prompt/question
- correct_answer_fr: ONE example correct answer (or null for very open-ended questions)
- acceptable_variations: Array of 2-5 alternative acceptable answers (empty array for open-ended)
- topic: Category (e.g., "greetings", "food", "daily_routine", "verb_conjugation:être", "free_expression")
- difficulty: "beginner", "intermediate", or "advanced"
- question_type: "translation", "conjugation", "open_ended", "question_formation", "sentence_building"
- explanation: Brief explanation of the grammar/concept (in English)
- hints: Array of 1-3 hints to help students
- requires_complete_sentence: true for questions requiring full sentences

Return ONLY a valid JSON array with no markdown formatting:
[
  {
    "question_en": "How do you say 'hello' in French?",
    "correct_answer_fr": "bonjour",
    "acceptable_variations": ["salut", "allô"],
    "topic": "greetings",
    "difficulty": "beginner",
    "question_type": "translation",
    "explanation": "Basic greeting in French",
    "hints": ["This is a very common French greeting"],
    "requires_complete_sentence": false
  },
  {
    "question_en": "What are you going to do after school today?",
    "correct_answer_fr": "Je vais faire mes devoirs",
    "acceptable_variations": ["Je vais rentrer chez moi", "Je vais jouer au foot"],
    "topic": "daily_routine",
    "difficulty": "advanced",
    "question_type": "open_ended",
    "explanation": "Practice using near future tense (aller + infinitive) to express plans",
    "hints": ["Use 'Je vais...' to express what you're going to do", "Include a complete sentence"],
    "requires_complete_sentence": true
  }
]`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929', // Sonnet for question generation (good balance)
      max_tokens: 4096,
      temperature: 0.8, // Higher creativity for diverse questions
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
    const questions = JSON.parse(textContent.text) as WritingQuestion[];

    // Validate and return
    if (!Array.isArray(questions)) {
      throw new Error('Invalid response format');
    }

    return questions;
  } catch (error) {
    console.error('Failed to generate questions:', error);
    throw error;
  }
}
