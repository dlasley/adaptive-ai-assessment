/**
 * Supabase Client Configuration
 * Handles database connection with feature flag support
 */

import { createClient } from '@supabase/supabase-js';
import { FEATURES } from './feature-flags';

// Supabase configuration from environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Create Supabase client (only if DB_SYNC is enabled)
export const supabase = FEATURES.DB_SYNC && supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

// Helper to check if Supabase is available
export const isSupabaseAvailable = () => {
  return supabase !== null && FEATURES.DB_SYNC;
};

// Log Supabase status in development
if (process.env.NODE_ENV === 'development') {
  console.log('🗄️  Supabase Status:', {
    enabled: FEATURES.DB_SYNC,
    configured: !!supabaseUrl && !!supabaseAnonKey,
    available: isSupabaseAvailable(),
  });
}

// Database types (for TypeScript safety)
export interface StudyCode {
  id: string;
  code: string;
  display_name: string | null;
  admin_label: string | null;
  is_superuser: boolean;
  created_at: string;
  last_active_at: string;
  total_quizzes: number;
  total_questions: number;
  correct_answers: number;
}

export interface QuizHistory {
  id: string;
  study_code_id: string;
  quiz_date: string;
  unit_id: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  total_questions: number;
  correct_answers: number;
  score_percentage: number;
  time_spent_seconds: number | null;
}

export interface QuestionResult {
  id: string;
  quiz_history_id: string;
  study_code_id: string;
  question_id: string;
  topic: string;
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  is_correct: boolean;
  user_answer: string | null;
  correct_answer: string;
  attempted_at: string;
}

export interface ConceptMastery {
  study_code_id: string;
  topic: string;
  total_attempts: number;
  correct_attempts: number;
  mastery_percentage: number;
  last_attempted: string;
}

export interface WeakTopic {
  study_code_id: string;
  topic: string;
  total_attempts: number;
  correct_attempts: number;
  mastery_percentage: number;
}
