import { describe, expect, it } from 'vitest';
import { getEvaluationAnnouncement, getProgressAnnouncement } from '@/lib/quiz-announcements';

describe('getEvaluationAnnouncement', () => {
  it('announces a correct answer', () => {
    expect(getEvaluationAnnouncement(true)).toBe('Correct!');
  });

  it('announces an incorrect answer and points to the feedback below', () => {
    expect(getEvaluationAnnouncement(false)).toBe('Not quite right, see feedback below.');
  });
});

describe('getProgressAnnouncement', () => {
  it('reports the current question number and total', () => {
    expect(getProgressAnnouncement(1, 10)).toBe('Question 1 of 10');
    expect(getProgressAnnouncement(10, 10)).toBe('Question 10 of 10');
  });
});
