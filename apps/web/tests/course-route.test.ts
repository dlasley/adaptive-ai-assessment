import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { filesNamingSecrets, moduleGraph, webSrc } from './module-graph';

type CourseRouteModule = typeof import('@/app/api/course/route');

// getCourse() memoizes its first read, so each case loads a fresh module graph after setting env.
async function loadRoute(env: Record<string, string | undefined>): Promise<CourseRouteModule> {
  vi.resetModules();
  vi.stubEnv('VERCEL_ENV', undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return import('@/app/api/course/route');
}

function sortedKeys(value: unknown): string[] {
  return Object.keys(value as Record<string, unknown>).sort();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/course', () => {
  it('returns exactly the course, features and limits keys a client reads', async () => {
    const { GET } = await loadRoute({ COURSE_NAME: 'French II', COURSE_TITLE: 'Configured Title' });

    const response = GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(sortedKeys(body)).toEqual(['course', 'features', 'limits']);
    expect(sortedKeys(body.course)).toEqual(
      ['icon', 'language', 'name', 'nativeLanguageName', 'specialCharacters', 'title'],
    );
    expect(sortedKeys(body.features)).toEqual(['leitner']);
    expect(sortedKeys(body.limits)).toEqual(
      ['maxQuestions', 'wrongAnswerCountdownSeconds', 'wrongAnswerMinWaitSeconds'],
    );
  });

  it('reads its values from the course config, feature flags and quiz limits', async () => {
    const { GET } = await loadRoute({ COURSE_NAME: 'French II', COURSE_TITLE: 'Configured Title' });
    const { COURSE_CONTENT } = await import('@adaptive/shared/course');
    const { FEATURES } = await import('@/lib/feature-flags');
    const { MAX_QUESTIONS } = await import('@/lib/api-schemas');

    const body = await GET().json();

    expect(body).toEqual({
      course: {
        name: 'French II',
        title: 'Configured Title',
        language: COURSE_CONTENT.language,
        nativeLanguageName: COURSE_CONTENT.nativeLanguageName,
        icon: COURSE_CONTENT.icon ?? null,
        specialCharacters: COURSE_CONTENT.specialCharacters,
      },
      features: { leitner: FEATURES.LEITNER_MODE },
      limits: {
        maxQuestions: MAX_QUESTIONS,
        wrongAnswerCountdownSeconds: FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS,
        wrongAnswerMinWaitSeconds: FEATURES.WRONG_ANSWER_MIN_WAIT_SECONDS,
      },
    });
  });

  it('reports leitner as enabled when the Leitner flag is on', async () => {
    const { GET } = await loadRoute({ NEXT_PUBLIC_ENABLE_LEITNER: 'true' });

    const body = await GET().json();

    expect(body.features.leitner).toBe(true);
  });

  it('serves the configured COURSE_TITLE when set', async () => {
    const { GET } = await loadRoute({ COURSE_TITLE: 'Configured Title' });

    const body = await GET().json();

    expect(body.course.title).toBe('Configured Title');
  });

  it('falls back to the development default title when COURSE_TITLE is unset', async () => {
    const { GET } = await loadRoute({ COURSE_NAME: undefined, COURSE_TITLE: undefined });

    const body = await GET().json();

    expect(body.course.name).toBe('French II');
    expect(body.course.title).toBe('French II Practice & Assessment');
  });

  it('sets the same short CDN cache as /api/units', async () => {
    const { GET } = await loadRoute({});

    const response = GET();

    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=60, s-maxage=300, stale-while-revalidate=60',
    );
  });
});

describe('GET /api/course secret boundary', () => {
  const graph = moduleGraph(path.join(webSrc, 'app/api/course/route.ts'));

  it('follows the route into the modules it reads from', () => {
    const relative = graph.map((file) => path.relative(webSrc, file).split(path.sep).join('/'));
    expect(relative).toEqual(expect.arrayContaining([
      'app/api/course/route.ts',
      '../../../packages/shared/src/course.ts',
      'lib/feature-flags.ts',
      'lib/api-schemas.ts',
    ]));
  });

  it('never reaches a module that reads the OpenRouter key or the Turnstile secret', () => {
    expect(filesNamingSecrets(graph)).toEqual([]);
  });

  // The source scan above sees only names written literally; this checks the served bytes. The
  // secrets are set because JSON drops a field whose value is undefined.
  it('never serves the OpenRouter key or the Turnstile secret when both are set', async () => {
    const { GET } = await loadRoute({
      OPENROUTER_API_KEY: 'sentinel-openrouter-key',
      TURNSTILE_SECRET_KEY: 'sentinel-turnstile-secret',
    });

    const text = await GET().text();

    expect(text).not.toContain('sentinel-openrouter-key');
    expect(text).not.toContain('sentinel-turnstile-secret');
    expect(sortedKeys(JSON.parse(text))).toEqual(['course', 'features', 'limits']);
  });

  it('detects a module graph that does reach a secret', () => {
    const turnstileGraph = moduleGraph(path.join(webSrc, 'lib/turnstile.ts'));
    expect(filesNamingSecrets(turnstileGraph)).not.toEqual([]);
  });
});
