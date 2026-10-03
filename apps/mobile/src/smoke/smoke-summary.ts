import { DIFFICULTIES } from '@adaptive/shared/enums';
import type { ApiClient } from '../api/client';

export interface SmokeSummary {
  courseTitle: string;
  unitCount: number;
  /** Read from `@adaptive/shared`, so a value here shows the bundler resolved the shared package. */
  difficultyCount: number;
}

export async function loadSmokeSummary(client: ApiClient): Promise<SmokeSummary> {
  const [course, units] = await Promise.all([client.getCourse(), client.getUnits()]);
  return {
    courseTitle: course.course.title,
    unitCount: units.length,
    difficultyCount: DIFFICULTIES.length,
  };
}
