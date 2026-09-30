/**
 * Fetch units from the database (for scripts and server-side code).
 * Rows are cast to `Unit` without renaming fields, so `Unit` keeps
 * `source_file_stem` in the DB's own snake_case rather than a camelCase alias.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Unit } from '@adaptive/shared/types';

export async function fetchUnitsFromDb(supabase: SupabaseClient): Promise<Unit[]> {
  const { data, error } = await supabase
    .from('units')
    .select('id, title, label, description, topics, sort_order, source_file_stem')
    .order('sort_order');

  if (error) {
    throw new Error(`Failed to fetch units: ${error.message}`);
  }

  return data as Unit[];
}
