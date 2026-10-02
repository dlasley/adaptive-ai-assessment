/**
 * Shared database query utilities for pipeline scripts.
 *
 * Provides Supabase client init, paginated question fetch,
 * and distribution analysis — used by questions-plan.ts.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { assertSupabaseTarget, resolveSupabaseRef } from './supabase-target';
import { createLogger } from './logger';
import { loadEnv } from './env';

const logger = createLogger('db-queries');

/**
 * Row shape for the `questions` table. Which fields are actually populated depends on the
 * caller's `.select()` string, not this interface — Supabase controls the columns returned, so
 * most fields here are typed as always-present even though a narrow select may omit them.
 */
export interface QuestionRow {
  id: string;
  question: string;
  correct_answer: string;
  explanation: string | null;
  unit_id: string;
  topic: string;
  difficulty: string;
  type: string;
  options: string[] | null;
  acceptable_variations: string[] | null;
  writing_type: string | null;
  hints: string[] | null;
  has_complete_sentence_requirement: boolean | null;
  content_hash: string | null;
  batch_id: string | null;
  source_file: string | null;
  generated_by: string | null;
  quality_status: string | null;
  audit_metadata: any;
}

export interface DistributionAnalysis {
  total: number;
  byType: Record<string, number>;
  byWritingType: Record<string, number>;
  writingTotal: number;
}

/**
 * Create a Supabase client with the service-role key (`SUPABASE_SECRET_KEY`, bypasses RLS).
 * Exits the process if the URL or the key is missing: the anon key would return zero rows from
 * the question bank and units instead of failing, so the pipeline never uses it.
 *
 * @param opts.write - The caller is about to mutate the database: the resolved target must be
 *                     confirmed first (see `assertSupabaseTarget`).
 */
export function createScriptSupabase(opts?: { write?: boolean }): SupabaseClient {
  loadEnv();
  assertSupabaseTarget({ write: !!opts?.write });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    logger.error('Missing NEXT_PUBLIC_SUPABASE_URL');
    process.exit(1);
  }
  if (!secretKey) {
    logger.error('SUPABASE_SECRET_KEY is required: the anon key reads nothing from the question bank or units.');
    process.exit(1);
  }

  return createClient(supabaseUrl, secretKey);
}

/** A `SupabaseClient.from(table)` result narrowed to only the `select()` entry point — the type
 * `ReadOnlySupabaseClient` offers, so a table this client reads can't be written through it. */
type SelectOnlyFrom = { select: ReturnType<SupabaseClient['from']>['select'] };

/** The read surface `createServiceReadClient()` returns: `.from(table).select(...)`, and nothing
 * that would let a caller `.insert()`/`.update()`/`.delete()`. */
export interface ReadOnlySupabaseClient {
  from(table: string): SelectOnlyFrom;
}

/**
 * A service-key client for trusted local reads against a table with RLS enabled and no
 * anon-readable policies (e.g. `llm_batch_jobs`, service-role only by design). The anon-key
 * client `createScriptSupabase()` returns would run such a `.select()` successfully and get back
 * `[]` — not an error — which is a worse failure mode than refusing loudly.
 *
 * Deliberately bypasses `assertSupabaseTarget()`'s write-confirmation flow: that gate exists to
 * stop an unconfirmed *mutation* from landing on the wrong project, and nothing here ever mutates
 * anything. Still prints the resolved target, the same way a read-only `createScriptSupabase()`
 * call does, so the operator sees which project is being read from. The narrowed return type
 * (`ReadOnlySupabaseClient`) means a caller can't reach `.insert()`/`.update()`/`.delete()` through
 * it even by mistake.
 */
export function createServiceReadClient(): ReadOnlySupabaseClient {
  loadEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    logger.error('Missing NEXT_PUBLIC_SUPABASE_URL');
    process.exit(1);
  }
  if (!secretKey) {
    logger.error(
      'SUPABASE_SECRET_KEY is required to read a service-role-only table (e.g. llm_batch_jobs) — the anon key would silently return zero rows instead of an error.',
    );
    process.exit(1);
  }

  logger.info(`Supabase target (service read): ${resolveSupabaseRef(supabaseUrl) ?? '(unresolved)'} (${supabaseUrl})`);

  const client = createClient(supabaseUrl, secretKey);
  return {
    from(table: string): SelectOnlyFrom {
      const queryBuilder = client.from(table);
      return { select: queryBuilder.select.bind(queryBuilder) };
    },
  };
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
 * Generic paginated fetch for any Supabase table. Pages are ordered by `id` (after any ordering
 * `buildQuery` applies) so range paging cannot skip or repeat rows between requests.
 *
 * @param supabase - Supabase client
 * @param table - Table name
 * @param buildQuery - Callback to apply filters/ordering to the base query
 * @param selectFields - Columns to select (default: '*')
 */
export async function fetchAllPages<T>(
  supabase: SupabaseClient,
  table: string,
  buildQuery: (query: any) => any,
  selectFields = '*',
): Promise<T[]> {
  let all: T[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const baseQuery = supabase.from(table).select(selectFields);
    const query = buildQuery(baseQuery).order('id');
    const { data, error } = await query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Error fetching ${table}: ${error.message}`);
    }

    if (data && data.length > 0) {
      all = all.concat(data as T[]);
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
