import { describe, expect, it } from 'vitest';
import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { CourseResponse } from '../src/api/client';
import { loadCourseHeading } from '../src/features/code-entry/course-heading';

const course: CourseResponse = {
  course: {
    name: 'French II',
    title: 'French II Practice & Assessment',
    language: 'French',
    nativeLanguageName: 'Français',
    icon: null,
    specialCharacters: [],
  },
  features: { leitner: false },
  limits: { maxQuestions: 50, wrongAnswerCountdownSeconds: 15, wrongAnswerMinWaitSeconds: 3 },
};

describe('loadCourseHeading', () => {
  it('puts the shared course icon before the title the API returns', async () => {
    expect(COURSE_CONTENT.icon).toBeTruthy();
    await expect(loadCourseHeading({ getCourse: async () => course })).resolves.toBe(
      `${COURSE_CONTENT.icon} French II Practice & Assessment`,
    );
  });

  it('is null when the course cannot be loaded, so the screen shows no heading', async () => {
    await expect(
      loadCourseHeading({
        getCourse: async () => {
          throw new TypeError('Network request failed');
        },
      }),
    ).resolves.toBeNull();
  });
});
