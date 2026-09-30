import type { Difficulty, QuestionType, WritingType } from './enums';

/**
 * A stored topic heading. Heading text alone (`string`) is only valid when that exact text is
 * unique in the unit's source document — several documents repeat headings like "Exercices" or
 * "Warm Up" across sections, so a bare string would be ambiguous for those. A `{ heading, slide }`
 * pair pins the specific occurrence by the `<!-- slide N -->` in effect at that heading, and is
 * required whenever the heading text isn't unique.
 */
export type TopicHeadingRef = string | { heading: string; slide: number };

interface Topic {
  name: string;
  headings: TopicHeadingRef[];
}

export interface Unit {
  id: string;
  title: string;
  label?: string; // Short label for dropdown (e.g., "Activities & -ER Verbs")
  description: string;
  topics: Topic[];
  // Kept snake_case (not sourceFileStem) because it's read directly off the
  // Supabase row — see the fetchUnitsFromDb comment in apps/pipeline/lib/units-db.ts.
  /** Filename stem (no extension, e.g. "Unit 3") of this unit's source PDF/markdown in PDF/ and learnings/. Null until the pipeline discovers and upserts the unit. */
  source_file_stem?: string | null;
}

export interface Question {
  id: string;
  question: string;
  type: QuestionType;
  options?: string[];
  correctAnswer: string;
  explanation?: string;
  unitId: string;
  topic: string;
  difficulty: Difficulty;

  // Writing question specific fields
  writingType?: WritingType;
  acceptableVariations?: string[];
  hints?: string[];
  hasCompleteSentenceRequirement?: boolean;
}

export interface LearningResource {
  id: string;
  unitId: string;
  topic: string;
  resourceType: 'video' | 'article' | 'audio' | 'interactive';
  url: string;
  title: string;
  provider?: string;
  difficulty?: Difficulty;
  metadata?: Record<string, unknown>;
}
