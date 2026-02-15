/**
 * Client-side query helpers for learning resources.
 * Uses the same anon Supabase client as study-codes.ts.
 */

import { supabase, isSupabaseAvailable } from './supabase';
import type { LearningResource } from '@/types';

/**
 * Get resources for specific topics (across all units).
 * Used by the progress page to show videos for weak topics.
 */
export async function getResourcesForTopics(topics: string[]): Promise<LearningResource[]> {
  if (!isSupabaseAvailable() || topics.length === 0) return [];

  try {
    const { data, error } = await supabase!
      .from('learning_resources')
      .select('id, unit_id, topic, resource_type, url, title, provider, difficulty, metadata')
      .in('topic', topics)
      .eq('quality_status', 'active')
      .order('topic')
      .order('title');

    if (error) {
      console.error('Error fetching resources for topics:', error);
      return [];
    }

    return (data || []) as LearningResource[];
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
      .select('id, unit_id, topic, resource_type, url, title, provider, difficulty, metadata')
      .eq('unit_id', unitId)
      .eq('quality_status', 'active')
      .order('topic')
      .order('title');

    if (error) {
      console.error('Error fetching resources for unit:', error);
      return [];
    }

    return (data || []) as LearningResource[];
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
      .select('id, unit_id, topic, resource_type, url, title, provider, difficulty, metadata')
      .eq('quality_status', 'active')
      .order('topic')
      .order('unit_id')
      .order('title');

    if (error) {
      console.error('Error fetching all resources:', error);
      return [];
    }

    return (data || []) as LearningResource[];
  } catch (error) {
    console.error('Failed to get all resources:', error);
    return [];
  }
}

/**
 * Get resources for specific (topic, unitId) pairs.
 * Used by the study guide after a quiz to show relevant videos per incorrect topic.
 * Returns a map of topic → resources.
 */
export async function getResourcesForIncorrect(
  items: { topic: string; unitId: string }[]
): Promise<Map<string, LearningResource[]>> {
  const result = new Map<string, LearningResource[]>();
  if (!isSupabaseAvailable() || items.length === 0) return result;

  try {
    // Get unique topics and unitIds
    const topics = [...new Set(items.map(i => i.topic))];
    const unitIds = [...new Set(items.map(i => i.unitId))];

    const { data, error } = await supabase!
      .from('learning_resources')
      .select('id, unit_id, topic, resource_type, url, title, provider, difficulty, metadata')
      .in('topic', topics)
      .in('unit_id', unitIds)
      .eq('quality_status', 'active')
      .order('title');

    if (error) {
      console.error('Error fetching resources for incorrect:', error);
      return result;
    }

    // Group by topic
    for (const resource of (data || []) as LearningResource[]) {
      const existing = result.get(resource.topic) || [];
      existing.push(resource);
      result.set(resource.topic, existing);
    }

    return result;
  } catch (error) {
    console.error('Failed to get resources for incorrect:', error);
    return result;
  }
}
