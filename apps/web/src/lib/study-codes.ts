/**
 * Study Code Management
 * Handles anonymous student identification and progress tracking
 *
 * All access to a student's own data goes through server routes that
 * verify a signed session cookie before touching the database — this
 * module never talks to Supabase directly. Word lists behind code
 * generation live server-side in study_code_source_words (never in
 * source).
 */

import { QuizHistory, ConceptMastery } from './supabase';
import { STORAGE_KEYS } from './storage-keys';
import { fetchWithRetryAfter, retryAfterSeconds } from './retry-after';

// Local storage key for study code
export const STUDY_CODE_KEY = STORAGE_KEYS.studyCode;

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
 * Clear study code and skip-choice flag from localStorage.
 * Does not touch the server-side session cookie — call
 * clearStudyCodeAndSession() for that.
 */
function clearStudyCode(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STUDY_CODE_KEY);
  localStorage.removeItem(STORAGE_KEYS.skipChoice);
}

/**
 * Clears the local study code and ends the server-side session in one
 * step. Use this wherever "this isn't me" logic runs on a shared device —
 * clearing localStorage alone leaves the httpOnly session cookie valid
 * for whoever uses the browser next.
 */
export async function clearStudyCodeAndSession(): Promise<void> {
  clearStudyCode();
  try {
    await fetch('/api/student/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Failed to clear student session:', error);
  }
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
  return localStorage.getItem(STORAGE_KEYS.skipChoice) === 'true';
}

/**
 * Set or clear the skip-choice preference
 */
export function setSkipChoice(skip: boolean): void {
  if (typeof window === 'undefined') return;
  if (skip) {
    localStorage.setItem(STORAGE_KEYS.skipChoice, 'true');
  } else {
    localStorage.removeItem(STORAGE_KEYS.skipChoice);
  }
}

/**
 * Create a new study code via the server-side API route.
 * The API handles word selection (two adjectives and an animal),
 * collision retry, rate limiting, and mints the session cookie.
 * A 429 is retried once after the server's Retry-After delay.
 * Returns the code on success, null on failure.
 */
export async function createStudyCode(onBusy?: () => void): Promise<string | null> {
  try {
    const response = await fetchWithRetryAfter(
      '/api/generate-code',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      onBusy,
    );

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

export type VerifyCodeResult =
  | { status: 'valid' }
  | { status: 'invalid' }
  | { status: 'turnstile_required'; siteKey: string }
  | { status: 'rate_limited'; retryAfterSeconds: number | null }
  | { status: 'error' };

/**
 * Verify that a study code exists via the rate-limited API route.
 * Mints/refreshes the session cookie as a side effect on success.
 *
 * When verify-code's circuit breaker is tightened, the server responds
 * 403 with a Turnstile site key instead of a plain exists/not-exists
 * result. Callers that can present a challenge should re-invoke this with
 * the solved turnstileToken; callers that can't should treat
 * 'turnstile_required' the same as 'error'. A 429 (a per-IP or per-code lock, or the site-wide
 * breaker) comes back as 'rate_limited' with the server's Retry-After.
 */
export async function verifyStudyCode(code: string, turnstileToken?: string): Promise<VerifyCodeResult> {
  try {
    const response = await fetch('/api/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, turnstileToken }),
    });

    if (response.status === 403) {
      const body = await response.json().catch(() => ({}));
      if (body.turnstileRequired && typeof body.turnstileSiteKey === 'string') {
        return { status: 'turnstile_required', siteKey: body.turnstileSiteKey };
      }
      return { status: 'error' };
    }

    if (response.status === 429) {
      return { status: 'rate_limited', retryAfterSeconds: retryAfterSeconds(response) };
    }

    if (!response.ok) return { status: 'error' };

    const { exists } = await response.json();
    return { status: exists === true ? 'valid' : 'invalid' };
  } catch (error) {
    console.error('Error verifying study code:', error);
    return { status: 'error' };
  }
}

/**
 * Whether a usable student session cookie is currently present.
 */
export async function hasActiveStudentSession(): Promise<boolean> {
  try {
    const response = await fetch('/api/student/session');
    if (!response.ok) return false;
    const { authenticated } = await response.json();
    return authenticated === true;
  } catch (error) {
    console.error('Error checking student session:', error);
    return false;
  }
}

interface StudentDashboardProfile {
  code: string;
  displayName: string | null;
  createdAt: string;
  totalQuizzes: number;
  totalQuestions: number;
  correctAnswers: number;
}

export interface StudentDashboard {
  profile: StudentDashboardProfile;
  quizHistory: QuizHistory[];
  conceptMastery: ConceptMastery[];
  weakTopics: ConceptMastery[];
}

/**
 * Fetches the session's own profile, quiz history, concept mastery, and
 * weak topics in one request. Returns null on any failure (no session,
 * network error, etc.) — callers treat that the same as "no data yet".
 */
export async function getStudentDashboard(): Promise<StudentDashboard | null> {
  try {
    const response = await fetch('/api/student/dashboard');
    if (!response.ok) return null;
    return (await response.json()) as StudentDashboard;
  } catch (error) {
    console.error('Failed to get student dashboard:', error);
    return null;
  }
}
