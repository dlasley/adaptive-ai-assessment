/**
 * Study Code Management
 * Handles anonymous student identification and progress tracking
 */

import { supabase, isSupabaseAvailable, StudyCode, QuizHistory, ConceptMastery } from './supabase';

// Local storage key for study code
const STUDY_CODE_KEY = 'french_study_code';

// Curated adjectives - family-friendly, easy to spell
const ADJECTIVES = [
  'happy', 'brave', 'clever', 'swift', 'gentle', 'bright', 'calm', 'kind',
  'wise', 'bold', 'cool', 'warm', 'quick', 'strong', 'smart', 'proud',
  'loyal', 'noble', 'wild', 'free', 'sweet', 'pure', 'true', 'fair',
  'grand', 'great', 'fine', 'nice', 'good', 'dear', 'royal', 'magic',
  'lucky', 'jolly', 'merry', 'sunny', 'starry', 'golden', 'silver', 'peaceful',
  'playful', 'cheerful', 'hopeful', 'fearless', 'graceful', 'powerful', 'mighty', 'tiny',
  'giant', 'cosmic', 'arctic', 'tropical', 'mystic', 'epic', 'super', 'ultra',
  'mega', 'hyper', 'neo', 'retro', 'vintage', 'modern', 'ancient', 'future',
  'speedy', 'zippy', 'bouncy', 'fluffy', 'fuzzy', 'shiny', 'sparkly', 'glowing',
  'radiant', 'vibrant', 'vivid', 'dazzling', 'blazing', 'soaring', 'flying', 'sailing',
  'dancing', 'singing', 'smiling', 'laughing', 'dreaming', 'wondering', 'exploring', 'seeking',
  'daring', 'caring', 'sharing', 'loving', 'healing', 'helping', 'guiding', 'leading',
  'rising', 'shining', 'winning', 'roaring', 'howling', 'charging', 'racing', 'rushing',
  'stellar', 'lunar', 'solar', 'astral', 'crystal', 'diamond', 'emerald', 'sapphire',
  'ruby', 'amber', 'jade', 'pearl', 'coral', 'ocean', 'forest', 'mountain',
  'river', 'thunder', 'lightning', 'storm', 'cloud', 'rainbow', 'aurora', 'crimson',
  'azure', 'violet', 'scarlet', 'indigo', 'copper', 'bronze', 'keen', 'eager',
  'active', 'lively', 'peppy', 'perky', 'snappy', 'spunky', 'zippy', 'frisky'
];

// Curated animals - common, easy to spell
const ANIMALS = [
  'elephant', 'panda', 'dolphin', 'tiger', 'eagle', 'lion', 'bear', 'wolf',
  'fox', 'hawk', 'owl', 'deer', 'rabbit', 'otter', 'seal', 'whale',
  'shark', 'dragon', 'phoenix', 'griffin', 'unicorn', 'pegasus', 'sphinx', 'kraken',
  'leopard', 'jaguar', 'cheetah', 'panther', 'cougar', 'lynx', 'bobcat', 'ocelot',
  'monkey', 'gorilla', 'chimp', 'lemur', 'koala', 'kangaroo', 'wombat', 'platypus',
  'wallaby', 'badger', 'ferret', 'meerkat', 'raccoon', 'skunk', 'porcupine', 'hedgehog',
  'beaver', 'squirrel', 'chipmunk', 'hamster', 'gerbil', 'mouse', 'bat', 'raven',
  'crow', 'robin', 'sparrow', 'finch', 'cardinal', 'bluejay', 'hummingbird', 'pelican',
  'flamingo', 'stork', 'heron', 'crane', 'swan', 'goose', 'duck', 'penguin',
  'puffin', 'albatross', 'seagull', 'falcon', 'osprey', 'vulture', 'condor', 'parrot',
  'macaw', 'cockatoo', 'parakeet', 'canary', 'python', 'cobra', 'gecko', 'iguana',
  'turtle', 'tortoise', 'frog', 'toad', 'salamander', 'crab', 'lobster', 'shrimp',
  'octopus', 'squid', 'jellyfish', 'starfish', 'seahorse', 'clownfish', 'salmon', 'trout',
  'bass', 'catfish', 'goldfish', 'butterfly', 'dragonfly', 'firefly', 'ladybug', 'beetle',
  'cricket', 'mantis', 'moth', 'spider', 'scorpion', 'centipede', 'snail', 'slug',
  'worm', 'ant', 'bee', 'wasp', 'hornet', 'termite', 'mosquito', 'fly'
];

/**
 * Generate a new anonymous study code
 * Format: "adjective animal" (e.g., "happy elephant")
 * Uses spaces instead of dashes for easier typing on phones
 */
export function generateStudyCode(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adjective} ${animal}`;
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
 * Create a new study code in the database with collision handling
 * Returns the code on success, null on failure
 * Implements retry logic (up to 10 attempts) to handle duplicate codes
 */
export async function createStudyCode(displayName?: string, maxAttempts = 10): Promise<string | null> {
  // If Supabase not available, just return a local code
  if (!isSupabaseAvailable()) {
    const code = generateStudyCode();
    storeStudyCode(code);
    return code;
  }

  // Try up to maxAttempts times to generate a unique code
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const code = generateStudyCode();

      // Attempt to insert the code
      const { data, error } = await supabase!
        .from('study_codes')
        .insert({
          code,
          display_name: displayName || null,
        })
        .select()
        .single();

      // Success - code is unique
      if (!error && data) {
        storeStudyCode(code);
        console.log(`✓ Study code created: "${code}" (attempt ${attempt}/${maxAttempts})`);
        return code;
      }

      // Check if error is due to duplicate code
      if (error && error.code === '23505') {
        // Unique constraint violation - code already exists
        console.log(`⚠ Collision detected for "${code}", retrying... (attempt ${attempt}/${maxAttempts})`);
        continue; // Try again with a new code
      }

      // Other error - log and return null
      console.error('Error creating study code:', error);
      return null;
    } catch (error) {
      console.error('Failed to create study code:', error);
      // Continue trying if we haven't exhausted attempts
      if (attempt === maxAttempts) {
        return null;
      }
    }
  }

  // Exhausted all attempts
  console.error(`Failed to generate unique study code after ${maxAttempts} attempts`);
  return null;
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
