/**
 * Supabase Client Configuration
 * Connects to Supabase when URL and key are configured
 */

import { createClient } from '@supabase/supabase-js';
import type { Difficulty } from '@adaptive/shared/enums';
import { createLogger } from './logger';

const logger = createLogger('supabase');

// Supabase configuration from environment variables
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// Create Supabase client when credentials are configured
export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

// Helper to check if Supabase is available
export const isSupabaseAvailable = () => {
  return supabase !== null;
};

logger.debug('Supabase status', {
  configured: !!supabaseUrl && !!supabaseAnonKey,
  available: isSupabaseAvailable(),
});

// Database types (for TypeScript safety)
export interface QuizHistory {
  id: string;
  study_code_id: string;
  quiz_date: string;
  unit_id: string;
  difficulty: Difficulty;
  total_questions: number;
  correct_answers: number;
  score_percentage: number;
  time_spent_seconds: number | null;
}

export interface ConceptMastery {
  study_code_id: string;
  topic: string;
  total_attempts: number;
  correct_attempts: number;
  mastery_percentage: number;
  last_attempted: string;
}

