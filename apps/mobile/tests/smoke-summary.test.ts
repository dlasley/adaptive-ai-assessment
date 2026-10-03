import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '@adaptive/shared/enums';
import type { ApiClient } from '../src/api/client';
import { loadSmokeSummary } from '../src/smoke/smoke-summary';

describe('loadSmokeSummary', () => {
  it('reports the course title, unit count and the shared difficulty count', async () => {
    const client: ApiClient = {
      getCourse: async () => ({
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
      }),
      getUnits: async () => [
        { id: 'unit-1', title: 'Unit 1', label: null, description: '', topics: [], sort_order: 1 },
        { id: 'unit-2', title: 'Unit 2', label: null, description: '', topics: [], sort_order: 2 },
      ],
      logout: async () => ({ status: 200, body: null }),
    };

    await expect(loadSmokeSummary(client)).resolves.toEqual({
      courseTitle: 'French II Practice & Assessment',
      unitCount: 2,
      difficultyCount: 3,
    });
    expect(DIFFICULTIES.length).toBe(3);
  });
});
