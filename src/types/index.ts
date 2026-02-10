export interface Topic {
  name: string;
  headings: string[];
}

export interface Unit {
  id: string;
  title: string;
  label?: string; // Short label for dropdown (e.g., "Activities & -ER Verbs")
  description: string;
  topics: Topic[];
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
