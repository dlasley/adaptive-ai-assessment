/**
 * Admin/Teacher Dashboard Functions
 * Provides access to all student data for teachers
 */

import { supabase, isSupabaseAvailable, StudyCode, QuizHistory, ConceptMastery } from './supabase';

export interface ClasswideStats {
  totalStudents: number;
  totalQuizzes: number;
  totalQuestions: number;
  averageAccuracy: number;
  activeStudentsLast7Days: number;
  activeStudentsLast30Days: number;
}

export interface StudentSummary {
  code: string;
  displayName: string | null;
  adminLabel: string | null;
  totalQuizzes: number;
  totalQuestions: number;
  correctAnswers: number;
  overallAccuracy: number;
  lastActive: string;
  createdAt: string;
}

/**
 * Get class-wide statistics
 */
export async function getClasswideStats(): Promise<ClasswideStats | null> {
  if (!isSupabaseAvailable()) return null;

  try {
    // Get total students
    const { count: totalStudents } = await supabase!
      .from('study_codes')
      .select('*', { count: 'exact', head: true });

    // Get total quizzes
    const { count: totalQuizzes } = await supabase!
      .from('quiz_history')
      .select('*', { count: 'exact', head: true });

    // Get total questions answered
    const { data: studyCodes } = await supabase!
      .from('study_codes')
      .select('total_questions, correct_answers');

    const totalQuestions = studyCodes?.reduce((sum, sc) => sum + (sc.total_questions || 0), 0) || 0;
    const totalCorrect = studyCodes?.reduce((sum, sc) => sum + (sc.correct_answers || 0), 0) || 0;
    const averageAccuracy = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;

    // Get active students (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const { count: activeStudentsLast7Days } = await supabase!
      .from('study_codes')
      .select('*', { count: 'exact', head: true })
      .gte('last_active_at', sevenDaysAgo.toISOString());

    // Get active students (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const { count: activeStudentsLast30Days } = await supabase!
      .from('study_codes')
      .select('*', { count: 'exact', head: true })
      .gte('last_active_at', thirtyDaysAgo.toISOString());

    return {
      totalStudents: totalStudents || 0,
      totalQuizzes: totalQuizzes || 0,
      totalQuestions,
      averageAccuracy,
      activeStudentsLast7Days: activeStudentsLast7Days || 0,
      activeStudentsLast30Days: activeStudentsLast30Days || 0,
    };
  } catch (error) {
    console.error('Error fetching classwide stats:', error);
    return null;
  }
}

/**
 * Get all students with summary data
 */
export async function getAllStudents(sortBy: 'lastActive' | 'accuracy' | 'quizzes' = 'lastActive'): Promise<StudentSummary[]> {
  if (!isSupabaseAvailable()) return [];

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('*')
      .order('last_active_at', { ascending: false });

    if (error) {
      console.error('Error fetching students:', error);
      return [];
    }

    const students: StudentSummary[] = (data || []).map((sc) => {
      const overallAccuracy = sc.total_questions > 0
        ? (sc.correct_answers / sc.total_questions) * 100
        : 0;

      return {
        code: sc.code,
        displayName: sc.display_name,
        adminLabel: sc.admin_label,
        totalQuizzes: sc.total_quizzes || 0,
        totalQuestions: sc.total_questions || 0,
        correctAnswers: sc.correct_answers || 0,
        overallAccuracy,
        lastActive: sc.last_active_at,
        createdAt: sc.created_at,
      };
    });

    // Sort based on sortBy parameter
    if (sortBy === 'accuracy') {
      students.sort((a, b) => b.overallAccuracy - a.overallAccuracy);
    } else if (sortBy === 'quizzes') {
      students.sort((a, b) => b.totalQuizzes - a.totalQuizzes);
    }

    return students;
  } catch (error) {
    console.error('Error fetching all students:', error);
    return [];
  }
}

/**
 * Search students by code or display name
 */
export async function searchStudents(query: string): Promise<StudentSummary[]> {
  if (!isSupabaseAvailable() || !query) return [];

  try {
    const { data, error } = await supabase!
      .from('study_codes')
      .select('*')
      .or(`code.ilike.%${query}%,display_name.ilike.%${query}%,admin_label.ilike.%${query}%`)
      .order('last_active_at', { ascending: false });

    if (error) {
      console.error('Error searching students:', error);
      return [];
    }

    return (data || []).map((sc) => ({
      code: sc.code,
      displayName: sc.display_name,
      adminLabel: sc.admin_label,
      totalQuizzes: sc.total_quizzes || 0,
      totalQuestions: sc.total_questions || 0,
      correctAnswers: sc.correct_answers || 0,
      overallAccuracy: sc.total_questions > 0
        ? (sc.correct_answers / sc.total_questions) * 100
        : 0,
      lastActive: sc.last_active_at,
      createdAt: sc.created_at,
    }));
  } catch (error) {
    console.error('Error searching students:', error);
    return [];
  }
}

/**
 * Get detailed progress for a specific student (by study code)
 */
export interface StudentDetailedProgress {
  studyCode: StudentSummary;
  quizHistory: QuizHistory[];
  conceptMastery: ConceptMastery[];
  weakTopics: ConceptMastery[];
}

export async function getStudentProgress(code: string): Promise<StudentDetailedProgress | null> {
  if (!isSupabaseAvailable()) return null;

  try {
    // Get study code details
    const { data: studyCodeData } = await supabase!
      .from('study_codes')
      .select('*')
      .eq('code', code)
      .single();

    if (!studyCodeData) return null;

    const studyCode: StudentSummary = {
      code: studyCodeData.code,
      displayName: studyCodeData.display_name,
      adminLabel: studyCodeData.admin_label,
      totalQuizzes: studyCodeData.total_quizzes || 0,
      totalQuestions: studyCodeData.total_questions || 0,
      correctAnswers: studyCodeData.correct_answers || 0,
      overallAccuracy: studyCodeData.total_questions > 0
        ? (studyCodeData.correct_answers / studyCodeData.total_questions) * 100
        : 0,
      lastActive: studyCodeData.last_active_at,
      createdAt: studyCodeData.created_at,
    };

    // Get quiz history
    const { data: quizHistory } = await supabase!
      .from('quiz_history')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('quiz_date', { ascending: false });

    // Get concept mastery
    const { data: conceptMastery } = await supabase!
      .from('concept_mastery')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: false });

    // Get weak topics
    const { data: weakTopics } = await supabase!
      .from('weak_topics')
      .select('*')
      .eq('study_code_id', studyCodeData.id)
      .order('mastery_percentage', { ascending: true });

    return {
      studyCode,
      quizHistory: quizHistory || [],
      conceptMastery: conceptMastery || [],
      weakTopics: weakTopics || [],
    };
  } catch (error) {
    console.error('Error fetching student progress:', error);
    return null;
  }
}

/**
 * Update admin label for a study code
 */
export async function updateAdminLabel(code: string, adminLabel: string): Promise<boolean> {
  if (!isSupabaseAvailable()) return false;

  try {
    const { error } = await supabase!
      .from('study_codes')
      .update({ admin_label: adminLabel })
      .eq('code', code);

    if (error) {
      console.error('Error updating admin label:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Failed to update admin label:', error);
    return false;
  }
}

/**
 * Export all student data as CSV
 */
export function exportStudentsToCSV(students: StudentSummary[]): string {
  // Helper to format dates in PST
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

  const rows = students.map((s) => [
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
