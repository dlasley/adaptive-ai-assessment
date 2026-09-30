import { describe, expect, it } from 'vitest';
import { dbToStudyCodeSummary } from '@/lib/study-code-mapper';

describe('dbToStudyCodeSummary', () => {
  it('maps a study_codes row to its camelCase summary and computes overall accuracy', () => {
    const row = {
      code: 'curious-otter',
      display_name: 'Alice',
      admin_label: 'VIP',
      wrong_answer_countdown: 20,
      total_quizzes: 4,
      total_questions: 40,
      correct_answers: 30,
      last_active_at: '2026-01-01T00:00:00.000Z',
      created_at: '2025-12-01T00:00:00.000Z',
    };

    expect(dbToStudyCodeSummary(row)).toEqual({
      code: 'curious-otter',
      displayName: 'Alice',
      adminLabel: 'VIP',
      wrongAnswerCountdown: 20,
      totalQuizzes: 4,
      totalQuestions: 40,
      correctAnswers: 30,
      overallAccuracy: 75,
      lastActive: '2026-01-01T00:00:00.000Z',
      createdAt: '2025-12-01T00:00:00.000Z',
    });
  });

  it('reports zero accuracy rather than dividing by zero when total_questions is zero', () => {
    const row = { code: 'new-code', total_questions: 0, correct_answers: 0 };

    expect(dbToStudyCodeSummary(row).overallAccuracy).toBe(0);
  });

  it('defaults wrongAnswerCountdown to null when absent from the row', () => {
    const row = { code: 'new-code' };

    expect(dbToStudyCodeSummary(row).wrongAnswerCountdown).toBeNull();
  });
});
