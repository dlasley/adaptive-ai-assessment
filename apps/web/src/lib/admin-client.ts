/**
 * Browser-side fetch wrapper for the admin dashboard: calls the server-side admin API routes
 * (`/api/admin/*`, guarded by `admin-route-guard.ts`'s `requireAdmin()`) and shapes their
 * responses into the types below. Runs in the browser, so it carries no session logic itself —
 * that lives in `admin-session.ts`.
 */

import type { QuizHistory, ConceptMastery } from './supabase';

export interface ClasswideStats {
  totalStudyCodes: number;
  totalQuizzes: number;
  totalQuestions: number;
  averageAccuracy: number;
  activeStudyCodesLast7Days: number;
  activeStudyCodesLast30Days: number;
  /** Study codes with no quiz activity for 90 days. */
  inactiveStudyCodes: number;
}

export interface StudyCodeSummary {
  code: string;
  displayName: string | null;
  adminLabel: string | null;
  wrongAnswerCountdown: number | null;
  totalQuizzes: number;
  totalQuestions: number;
  correctAnswers: number;
  overallAccuracy: number;
  lastActive: string;
  createdAt: string;
}

export interface StudyCodeDetailedProgress {
  studyCode: StudyCodeSummary;
  quizHistory: QuizHistory[];
  conceptMastery: ConceptMastery[];
  weakTopics: ConceptMastery[];
}

/**
 * Get class-wide statistics
 */
export async function getClasswideStats(): Promise<ClasswideStats | null> {
  try {
    const res = await fetch('/api/admin/stats');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get all study codes with summary data
 */
export async function getAllStudyCodes(sortBy: 'lastActive' | 'accuracy' | 'quizzes' = 'lastActive'): Promise<StudyCodeSummary[]> {
  try {
    const res = await fetch(`/api/admin/study-codes?sortBy=${sortBy}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Search study codes by code or display name
 */
export async function searchStudyCodes(query: string): Promise<StudyCodeSummary[]> {
  if (!query) return [];

  try {
    const res = await fetch(`/api/admin/study-codes?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Get detailed progress for a specific study code
 */
export async function getStudyCodeProgress(code: string): Promise<StudyCodeDetailedProgress | null> {
  try {
    const res = await fetch(`/api/admin/study-codes/${encodeURIComponent(code)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Update admin label for a study code
 */
export async function updateAdminLabel(code: string, adminLabel: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/study-codes/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminLabel }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Update wrong answer countdown override for a study code
 */
export async function updateCountdownOverride(code: string, seconds: number | null): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/study-codes/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wrongAnswerCountdown: seconds }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete a single study code and all its data
 */
export async function deleteStudyCode(code: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/admin/study-codes/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete multiple study codes at once
 */
export async function deleteStudyCodes(codes: string[]): Promise<{
  success: boolean;
  deleted: number;
  failed: string[];
}> {
  try {
    const res = await fetch('/api/admin/study-codes/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes }),
    });

    if (!res.ok) {
      return { success: false, deleted: 0, failed: codes };
    }

    return await res.json();
  } catch {
    return { success: false, deleted: 0, failed: codes };
  }
}

/**
 * Export all study code data as CSV
 */
export function exportStudyCodesToCSV(studyCodes: StudyCodeSummary[]): string {
  const formatDateTimePST = (dateString: string): string => {
    return new Date(dateString).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  };

  const headers = [
    'Study Code',
    'Display Name',
    'Admin Label',
    'Total Quizzes',
    'Total Questions',
    'Correct Answers',
    'Accuracy %',
    'Last Active (PST)',
    'Created At (PST)',
  ];

  const rows = studyCodes.map((s) => [
    s.code,
    s.displayName || 'Anonymous',
    s.adminLabel || '',
    s.totalQuizzes.toString(),
    s.totalQuestions.toString(),
    s.correctAnswers.toString(),
    s.overallAccuracy.toFixed(2),
    formatDateTimePST(s.lastActive),
    formatDateTimePST(s.createdAt),
  ]);

  const csv = [
    headers.join(','),
    ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
  ].join('\n');

  return csv;
}
