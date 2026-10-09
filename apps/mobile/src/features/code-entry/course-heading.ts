import { COURSE_CONTENT } from '@adaptive/shared/course';
import type { ApiClient } from '../../api/client';

/**
 * The course's icon and title for the top of the code-entry screen, as in the web app's header.
 * The title comes from `GET /api/course`; null when it cannot be loaded, so the screen shows none.
 */
export async function loadCourseHeading(client: Pick<ApiClient, 'getCourse'>): Promise<string | null> {
  let title: string;
  try {
    ({ title } = (await client.getCourse()).course);
  } catch {
    return null;
  }
  return COURSE_CONTENT.icon ? `${COURSE_CONTENT.icon} ${title}` : title;
}
