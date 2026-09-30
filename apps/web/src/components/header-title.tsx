'use client';

import { COURSE_CONTENT } from '@adaptive/shared/course';
import { buildHeaderText } from '@/lib/course-ui-copy';

/**
 * Receives the course title as a prop rather than reading
 * @adaptive/shared/course's getCourse() directly — that function reads
 * server-only env vars, which must not end up in the client bundle.
 * COURSE_CONTENT is env-free and safe to import here.
 */
export default function HeaderTitle({ title }: { title: string }) {
  return (
    <h1 className="text-2xl font-bold text-indigo-600 dark:text-indigo-400 select-none cursor-default">
      {buildHeaderText(title, COURSE_CONTENT.icon)}
    </h1>
  );
}
