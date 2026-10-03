import { NextResponse } from 'next/server';
import { COURSE_CONTENT, getCourse } from '@adaptive/shared/course';
import { FEATURES } from '@/lib/feature-flags';
import { MAX_QUESTIONS } from '@/lib/api-schemas';

/** The course identity, feature switches and quiz limits a client needs before its first quiz. */
export function GET() {
  const course = getCourse();

  return NextResponse.json(
    {
      course: {
        name: course.name,
        title: course.title,
        language: COURSE_CONTENT.language,
        nativeLanguageName: COURSE_CONTENT.nativeLanguageName,
        // null rather than absent, so the key set is the same whether or not an icon is configured.
        icon: COURSE_CONTENT.icon ?? null,
        specialCharacters: COURSE_CONTENT.specialCharacters,
      },
      features: {
        leitner: FEATURES.LEITNER_MODE,
      },
      limits: {
        maxQuestions: MAX_QUESTIONS,
        wrongAnswerCountdownSeconds: FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS,
        wrongAnswerMinWaitSeconds: FEATURES.WRONG_ANSWER_MIN_WAIT_SECONDS,
      },
    },
    {
      headers: {
        // Matches /api/units. Course values change only with a deploy or an env change, so the
        // same short CDN cache bounds how long a stale value can be served.
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
      },
    },
  );
}
