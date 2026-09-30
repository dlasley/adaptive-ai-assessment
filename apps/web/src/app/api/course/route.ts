import { NextResponse } from 'next/server';
import { getCourse } from '@adaptive/shared/course';

/**
 * Course branding for non-web clients (e.g. a future iOS app) that can't read
 * the server-side COURSE_NAME/COURSE_TITLE env vars directly. The web app
 * itself gets these values server-side, via layout metadata and a prop into
 * HeaderTitle — it doesn't call this route.
 */
export async function GET() {
  const course = getCourse();
  return NextResponse.json(
    { name: course.name, title: course.title },
    {
      headers: {
        // Branding changes only on redeploy (new COURSE_* env vars), which
        // already invalidates the CDN cache for the new deployment.
        'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=300',
      },
    },
  );
}
