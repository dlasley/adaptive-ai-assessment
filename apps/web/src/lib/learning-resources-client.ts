/**
 * Client-side query helpers for learning resources.
 * Uses the same anon Supabase client as study-codes.ts.
 */

import { supabase, isSupabaseAvailable } from './supabase';
import type { LearningResource } from '@adaptive/shared/types';
import type { Difficulty } from '@adaptive/shared/enums';

const SELECT_FIELDS = 'id, unit_id, topic, resource_type, url, title, provider, difficulty, metadata';

/**
 * Database learning-resource row type
 */
interface DBLearningResource {
  id: string;
  unit_id: string;
  topic: string;
  resource_type: 'video' | 'article' | 'audio' | 'interactive';
  url: string;
  title: string;
  provider?: string;
  difficulty?: Difficulty;
  metadata?: Record<string, unknown>;
}

/**
 * Convert database row to LearningResource type
 */
function dbToLearningResource(row: DBLearningResource): LearningResource {
  return {
    id: row.id,
    unitId: row.unit_id,
    topic: row.topic,
    resourceType: row.resource_type,
    url: row.url,
    title: row.title,
    provider: row.provider,
    difficulty: row.difficulty,
    metadata: row.metadata,
  };
}

/**
 * Get resources for specific topics (across all units).
 * Used by the progress page to show videos for weak topics.
 */
export async function getResourcesForTopics(topics: string[]): Promise<LearningResource[]> {
  if (!isSupabaseAvailable() || topics.length === 0) return [];

  try {
    const { data, error } = await supabase!
      .from('learning_resources')
      .select(SELECT_FIELDS)
      .in('topic', topics)
      .eq('quality_status', 'active')
      .order('topic')
      .order('title');

    if (error) {
      console.error('Error fetching resources for topics:', error);
      return [];
    }

    return ((data || []) as unknown as DBLearningResource[]).map(dbToLearningResource);
  } catch (error) {
    console.error('Failed to get resources for topics:', error);
    return [];
  }
}

/**
 * Get all resources for a specific unit.
 * Used by the Resources browse page (By Unit view).
 */
export async function getResourcesByUnit(unitId: string): Promise<LearningResource[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    const { data, error } = await supabase!
      .from('learning_resources')
      .select(SELECT_FIELDS)
      .eq('unit_id', unitId)
      .eq('quality_status', 'active')
      .order('topic')
      .order('title');

    if (error) {
      console.error('Error fetching resources for unit:', error);
      return [];
    }

    return ((data || []) as unknown as DBLearningResource[]).map(dbToLearningResource);
  } catch (error) {
    console.error('Failed to get resources for unit:', error);
    return [];
  }
}

/**
 * Get all active resources (for full browse page).
 * Used by the Resources browse page (By Topic view).
 */
export async function getAllResources(): Promise<LearningResource[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    const { data, error } = await supabase!
      .from('learning_resources')
      .select(SELECT_FIELDS)
      .eq('quality_status', 'active')
      .order('topic')
      .order('unit_id')
      .order('title');

    if (error) {
      console.error('Error fetching all resources:', error);
      return [];
    }

    return ((data || []) as unknown as DBLearningResource[]).map(dbToLearningResource);
  } catch (error) {
    console.error('Failed to get all resources:', error);
    return [];
  }
}
