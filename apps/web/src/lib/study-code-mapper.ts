/**
 * Maps a `study_codes` row to the camelCase summary shape served by the admin study-codes routes,
 * adding a computed overall-accuracy percentage.
 */
export interface StudyCodeSummary {
  code: unknown;
  displayName: unknown;
  adminLabel: unknown;
  wrongAnswerCountdown: unknown;
  totalQuizzes: number;
  totalQuestions: number;
  correctAnswers: number;
  overallAccuracy: number;
  lastActive: unknown;
  createdAt: unknown;
}

export function dbToStudyCodeSummary(sc: Record<string, unknown>): StudyCodeSummary {
  const totalQuestions = (sc.total_questions as number) || 0;
  const correctAnswers = (sc.correct_answers as number) || 0;
  return {
    code: sc.code,
    displayName: sc.display_name,
    adminLabel: sc.admin_label,
    wrongAnswerCountdown: sc.wrong_answer_countdown ?? null,
    totalQuizzes: (sc.total_quizzes as number) || 0,
    totalQuestions,
    correctAnswers,
    overallAccuracy: totalQuestions > 0 ? (correctAnswers / totalQuestions) * 100 : 0,
    lastActive: sc.last_active_at,
    createdAt: sc.created_at,
  };
}
