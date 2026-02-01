/**
 * Study Code Management
 * Handles anonymous student identification and progress tracking
 */

import { supabase, isSupabaseAvailable, StudyCode, QuizHistory, ConceptMastery } from './supabase';

// Local storage key for study code
const STUDY_CODE_KEY = 'french_study_code';

/**
 * Generate a new anonymous study code
 * Format: study-xxxxxxxx (8 random alphanumeric characters)
 */
export function generateStudyCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = 'study-';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Get the current user's study code from localStorage
 */
export function getStoredStudyCode(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(STUDY_CODE_KEY);
}

/**
 * Store study code in localStorage
 */
export function storeStudyCode(code: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STUDY_CODE_KEY, code);
}

/**
 * Clear study code from localStorage
 */
export function clearStudyCode(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STUDY_CODE_KEY);
}

/**
 * Create a new study code in the database
 * Returns the code on success, null on failure
 */
export async function createStudyCode(displayName?: string): Promise<string | null> {
  // If Supabase not available, just return a local code
  if (!isSupabaseAvailable()) {
    const code = generateStudyCode();
    storeStudyCode(code);
    return code;
  }

  try {
    const code = generateStudyCode();

    const { data, error } = await supabase!
      .from('study_codes')
      .insert({
        code,
        display_name: displayName || null,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating study code:', error);
      return null;
    }

    storeStudyCode(code);
    return code;
  } catch (error) {
    console.error('Failed to create study code:', error);
    return null;
  }
}

/**
 * Get or create a study code for the current user
 */
export async function getOrCreateStudyCode(): Promise<string> {
  // Check localStorage first
  const storedCode = getStoredStudyCode();
  if (storedCode) {
    // Verify it exists in database if Supabase is available
    if (isSupabaseAvailable()) {
      const exists = await verifyStudyCode(storedCode);
      if (exists) return storedCode;
    } else {
      // No database, just use local code
      return storedCode;
    }
  }

  // Create new code
  const newCode = await createStudyCode();
  return newCode || generateStudyCode(); // Fallback to local code
}

/**
 * Verify that a study code exists in the database
 */
export async function verifyStudyCode(code: string): Promise<boolean> {
  if (!isSupabaseAvailable()) return true; // Skip verification if DB not available

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', code)
      .single();

    return !error && !!data;
  } catch (error) {
    console.error('Error verifying study code:', error);
    return false;
  }
}

/**
 * Get study code details from database
 */
export async function getStudyCodeDetails(code: string): Promise<StudyCode | null> {
  if (!isSupabaseAvailable()) return null;

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('*')
      .eq('code', code)
      .single();

    if (error) {
      console.error('Error fetching study code:', error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Failed to get study code details:', error);
    return null;
  }
}

/**
 * Update display name for a study code
 */
export async function updateDisplayName(code: string, displayName: string): Promise<boolean> {
  if (!isSupabaseAvailable()) return false;

  try {
    const { error } = await supabase!
      .from('study_codes')
      .update({ display_name: displayName })
      .eq('code', code);

    if (error) {
      console.error('Error updating display name:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to update display name:', error);
    return false;
  }
}

/**
 * Get quiz history for a study code
 */
export async function getQuizHistory(code: string, limit = 10): Promise<QuizHistory[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    // First get the study code ID
    const { data: studyCodeData } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', code)
      .single();

    if (!studyCodeData) return [];

    const { data, error } = await supabase!
      .from('quiz_history')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('quiz_date', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Error fetching quiz history:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to get quiz history:', error);
    return [];
  }
}

/**
 * Get concept mastery for a study code
 */
export async function getConceptMastery(code: string): Promise<ConceptMastery[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    // First get the study code ID
    const { data: studyCodeData } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', code)
      .single();

    if (!studyCodeData) return [];

    const { data, error } = await supabase!
      .from('concept_mastery')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: true });

    if (error) {
      console.error('Error fetching concept mastery:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to get concept mastery:', error);
    return [];
  }
}

/**
 * Get weak topics for a study code (< 70% accuracy)
 */
export async function getWeakTopics(code: string): Promise<ConceptMastery[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    // First get the study code ID
    const { data: studyCodeData } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', code)
      .single();

    if (!studyCodeData) return [];

    const { data, error } = await supabase!
      .from('weak_topics')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: true });

    if (error) {
      console.error('Error fetching weak topics:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('Failed to get weak topics:', error);
    return [];
  }
}
