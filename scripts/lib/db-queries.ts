/**
 * Shared database query utilities for pipeline scripts.
 *
 * Provides Supabase client init, paginated question fetch,
 * and distribution analysis — used by plan-generation.ts and
 * check-writing-questions.ts.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Load environment variables (idempotent — safe to call multiple times)
config({ path: resolve(__dirname, '../../.env.local') });

export interface QuestionRow {
  id: string;
  unit_id: string;
  difficulty: string;
  type: string;
  writing_type: string | null;
  topic: string;
  question?: string;
  correct_answer?: string;
}

export interface DistributionAnalysis {
  total: number;
  byType: Record<string, number>;
  byWritingType: Record<string, number>;
  writingTotal: number;
}

/**
 * Create a Supabase client using env vars.
 * Exits the process if credentials are missing.
 */
export function createScriptSupabase(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing Supabase credentials');
    process.exit(1);
  }

  return createClient(supabaseUrl, supabaseKey);
}

const PAGE_SIZE = 1000;

/**
 * Fetch all questions from the database with pagination
 * to bypass Supabase's 1000-row default limit.
 */
export async function fetchAllQuestions(
  supabase: SupabaseClient,
  selectFields = 'id, unit_id, difficulty, type, writing_type, topic',
): Promise<QuestionRow[]> {
  let all: QuestionRow[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('questions')
      .select(selectFields)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Error fetching questions: ${error.message}`);
    }

    if (data && data.length > 0) {
      all = all.concat(data as unknown as QuestionRow[]);
      page++;
      hasMore = data.length === PAGE_SIZE;
    } else {
      hasMore = false;
    }
  }

  return all;
}

/**
 * Analyze question distribution by type and writing subtype.
 */
export function analyzeDistribution(questions: QuestionRow[]): DistributionAnalysis {
  const byType: Record<string, number> = {};
  const byWritingType: Record<string, number> = {};

  for (const q of questions) {
    byType[q.type] = (byType[q.type] || 0) + 1;
    if (q.type === 'writing') {
      const wt = q.writing_type || 'unspecified';
      byWritingType[wt] = (byWritingType[wt] || 0) + 1;
    }
  }

  return {
    total: questions.length,
    byType,
    byWritingType,
    writingTotal: byType['writing'] || 0,
  };
}
