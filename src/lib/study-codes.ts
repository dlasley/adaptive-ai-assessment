/**
 * Study Code Management
 * Handles anonymous student identification and progress tracking
 *
 * Code generation and verification go through rate-limited API routes
 * (/api/generate-code and /api/verify-code) to prevent brute-force attacks.
 * Word lists are stored server-side in study_code_source_words (never in source).
 */

import { supabase, isSupabaseAvailable, StudyCode, QuizHistory, ConceptMastery } from './supabase';

// Local storage key for study code
const STUDY_CODE_KEY = 'french_study_code';

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
 * Clear study code and skip-choice flag from localStorage
 */
export function clearStudyCode(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STUDY_CODE_KEY);
  localStorage.removeItem('french_skip_choice');
}

/**
 * Normalize a study code for comparison (trim + lowercase)
 */
export function normalizeStudyCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Check if the user has opted to skip the choice screen
 */
export function getSkipChoice(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('french_skip_choice') === 'true';
}

/**
 * Set or clear the skip-choice preference
 */
export function setSkipChoice(skip: boolean): void {
  if (typeof window === 'undefined') return;
  if (skip) {
    localStorage.setItem('french_skip_choice', 'true');
  } else {
    localStorage.removeItem('french_skip_choice');
  }
}

/**
 * Get the study code ID (UUID) from the code string
 * Returns null if not found or Supabase not available
 */
export async function getStudyCodeId(code: string): Promise<string | null> {
  if (!isSupabaseAvailable()) return null;

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('id')
      .eq('code', code)
      .single();

    if (error || !data) {
      return null;
    }

    return data.id;
  } catch (error) {
    console.error('Failed to get study code ID:', error);
    return null;
  }
}

/**
 * Create a new study code via the server-side API route.
 * The API handles word selection (with alliteration preference),
 * collision retry, and rate limiting.
 * Returns the code on success, null on failure.
 */
export async function createStudyCode(): Promise<string | null> {
  try {
    const response = await fetch('/api/generate-code', { method: 'POST' });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      console.error('Failed to create study code:', body.error || response.statusText);
      return null;
    }

    const { code } = await response.json();
    if (code) {
      storeStudyCode(code);
      return code;
    }

    return null;
  } catch (error) {
    console.error('Failed to create study code:', error);
    return null;
  }
}

/**
 * Get or create a study code for the current user.
 * Returns null if creation fails (caller should show the choosing screen).
 */
export async function getOrCreateStudyCode(): Promise<string | null> {
  // Check localStorage first
  const storedCode = getStoredStudyCode();
  if (storedCode) {
    // Verify it exists in database
    const exists = await verifyStudyCode(storedCode);
    if (exists) return storedCode;
  }

  // Create new code via API
  return createStudyCode();
}

/**
 * Verify that a study code exists via the rate-limited API route.
 */
export async function verifyStudyCode(code: string): Promise<boolean> {
  try {
    const response = await fetch('/api/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) return false;

    const { exists } = await response.json();
    return exists === true;
  } catch (error) {
    console.error('Error verifying study code:', error);
    return false;
  }
}

/**
 * Get study code details via the rate-limited API route.
 */
export async function getStudyCodeDetails(code: string): Promise<StudyCode | null> {
  try {
    const response = await fetch('/api/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!response.ok) return null;

    const { exists, details } = await response.json();
    if (!exists || !details) return null;

    return details as StudyCode;
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
