export interface Unit {
  id: string;
  title: string;
  description: string;
  topics: string[];
}

export interface Question {
  id: string;
  question: string;
  type: 'multiple-choice' | 'fill-in-blank' | 'true-false' | 'writing';
  options?: string[];
  correctAnswer: string;
  explanation?: string;
  unitId: string;
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';

  // Writing question specific fields
  writingType?: 'translation' | 'conjugation' | 'open_ended' | 'question_formation' | 'sentence_building';
  acceptableVariations?: string[];
  hints?: string[];
  requiresCompleteSentence?: boolean;
}

export interface QuizSession {
  unitId: string;
  topic: string;
  questions: Question[];
  currentQuestionIndex: number;
  answers: Record<string, string>;
  score?: number;
}

export interface QuestionGenerationRequest {
  unitId: string;
  topic: string;
  numQuestions: number;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
}
