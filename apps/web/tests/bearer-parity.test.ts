import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The real session guard runs against a database stand-in whose every query answers with the
// study code row below, so a route's status depends only on whether the guard accepts the request.
const { liveEpoch, fromMock } = vi.hoisted(() => {
  const liveEpoch = { value: 1 };
  const builder: object = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return () => Promise.resolve({ data: { id: 'row-id', session_epoch: liveEpoch.value }, error: null });
        }
        return () => builder;
      },
    },
  );
  const fromMock = vi.fn(() => builder);
  return { liveEpoch, fromMock };
});

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: fromMock },
  isSupabaseAdminAvailable: () => true,
}));

vi.mock('@/lib/rate-limiter', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 }),
  getClientIp: () => '203.0.113.9',
}));

vi.mock('@/lib/question-loader', () => ({
  loadQuestionsByIds: vi.fn().mockResolvedValue(new Map()),
}));

import { GET as checkSuperuserGet } from '@/app/api/check-superuser/route';
import { GET as dashboardGet } from '@/app/api/student/dashboard/route';
import { POST as quizResultsPost } from '@/app/api/student/quiz-results/route';
import { POST as leitnerPost } from '@/app/api/student/leitner/route';
import { POST as evaluateWritingPost } from '@/app/api/evaluate-writing/route';
import { createStudentSessionToken, getStudentCookieName } from '@/lib/student-session';

const PROD_URL = 'french-1.vercel.app';
const SECRET = 'test-student-secret-0123456789abcdef012345';
const QUESTION_ID = '11111111-1111-4111-8111-111111111111';

interface GuardedRoute {
  name: string;
  method: 'GET' | 'POST';
  handler: (request: NextRequest) => Promise<Response>;
  body?: unknown;
}

const ALWAYS_GUARDED: GuardedRoute[] = [
  { name: 'check-superuser', method: 'GET', handler: checkSuperuserGet },
  { name: 'student/dashboard', method: 'GET', handler: dashboardGet },
  {
    name: 'student/quiz-results',
    method: 'POST',
    handler: quizResultsPost,
    body: {
      unitId: 'all',
      difficulty: 'beginner',
      totalQuestions: 1,
      correctAnswers: 1,
      scorePercentage: 100,
      questions: [{ id: QUESTION_ID, topic: 'greetings', difficulty: 'beginner' }],
      userAnswers: { [QUESTION_ID]: 'Bonjour' },
    },
  },
  { name: 'student/leitner', method: 'POST', handler: leitnerPost, body: { questionId: QUESTION_ID, isCorrect: true } },
  { name: 'evaluate-writing', method: 'POST', handler: evaluateWritingPost, body: { questionId: QUESTION_ID, userAnswer: 'Bonjour' } },
];

function routeRequest(route: GuardedRoute, credentials: { authorization?: string; cookie?: string }): NextRequest {
  const headers = new Headers();
  if (route.method === 'POST') {
    headers.set('content-type', 'application/json');
    headers.set('origin', `https://${PROD_URL}`);
  }
  if (credentials.authorization !== undefined) headers.set('authorization', credentials.authorization);
  if (credentials.cookie !== undefined) headers.set('cookie', `${getStudentCookieName()}=${credentials.cookie}`);
  return new NextRequest(`https://${PROD_URL}/api/${route.name}`, {
    method: route.method,
    headers,
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

function tokenSignedWith(secret: string, studyCodeId: string, sessionEpoch: number): string {
  process.env.STUDENT_SESSION_SECRET = secret;
  try {
    return createStudentSessionToken(studyCodeId, sessionEpoch);
  } finally {
    process.env.STUDENT_SESSION_SECRET = SECRET;
  }
}

beforeEach(() => {
  process.env.STUDENT_SESSION_SECRET = SECRET;
  process.env.VERCEL_PROJECT_PRODUCTION_URL = PROD_URL;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_BRANCH_URL;
  liveEpoch.value = 1;
  fromMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe.each(ALWAYS_GUARDED)('$name accepts a bearer exactly as it accepts the cookie', (route) => {
  it('gives a valid bearer with no cookie the same status as a valid cookie with no bearer', async () => {
    const token = createStudentSessionToken('study-id', 1);

    const viaCookie = await route.handler(routeRequest(route, { cookie: token }));
    const viaBearer = await route.handler(routeRequest(route, { authorization: `Bearer ${token}` }));

    expect([401, 503]).not.toContain(viaCookie.status);
    expect(viaBearer.status).toBe(viaCookie.status);
  });

  it('answers 401 to a garbage bearer even with a valid cookie', async () => {
    const res = await route.handler(
      routeRequest(route, { authorization: 'Bearer garbage', cookie: createStudentSessionToken('study-id', 1) }),
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('answers 401 to a non-Bearer Authorization scheme even with a valid cookie', async () => {
    const res = await route.handler(
      routeRequest(route, { authorization: 'Basic dXNlcjpwYXNz', cookie: createStudentSessionToken('study-id', 1) }),
    );

    expect(res.status).toBe(401);
  });

  it('answers 401 to a valid session token sent under the Basic scheme', async () => {
    const res = await route.handler(
      routeRequest(route, { authorization: `Basic ${createStudentSessionToken('study-id', 1)}` }),
    );

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it('answers 401 to a bearer minted at epoch 2 against a row at epoch 5', async () => {
    liveEpoch.value = 5;

    const res = await route.handler(
      routeRequest(route, { authorization: `Bearer ${createStudentSessionToken('study-id', 2)}` }),
    );

    expect(res.status).toBe(401);
  });

  it('answers 401 to a bearer signed with a different secret', async () => {
    const foreign = tokenSignedWith('another-student-secret-0123456789abcdef0123', 'study-id', 1);

    const res = await route.handler(routeRequest(route, { authorization: `Bearer ${foreign}` }));

    expect(res.status).toBe(401);
  });
});

describe('the student cookie is named in one module only', () => {
  const webSrc = path.resolve(__dirname, '../src');
  const OWNER = 'lib/student-session.ts';
  const COOKIE_REFERENCE = /getStudentCookieName|student_session/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  const files = sourceFiles(webSrc).map((file) => ({
    relative: path.relative(webSrc, file).split(path.sep).join('/'),
    source: readFileSync(file, 'utf-8'),
  }));

  it('finds the app sources, including the owning module', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.find((f) => f.relative === OWNER)?.source).toMatch(COOKIE_REFERENCE);
  });

  it('never references getStudentCookieName or the literal cookie name outside student-session.ts', () => {
    const offenders = files.filter((f) => f.relative !== OWNER && COOKIE_REFERENCE.test(f.source)).map((f) => f.relative);
    expect(offenders).toEqual([]);
  });

  // Every cookie read outside the owner must be an exact read of the admin cookie. An allow-list
  // also catches a read that reaches the student cookie without naming it (through a helper's
  // `.name`, a variable, or getAll), and a read through `cookies()` from next/headers.
  const COOKIE_READ = /cookies(?:\(\)\)?)?\s*\.\s*(?:get|getAll|has)\s*\(([^\n]*)/g;
  const ADMIN_COOKIE_READS = ["'admin_session')", 'getAdminCookieName())'];

  it('reads no cookie outside student-session.ts except the admin session cookie', () => {
    const offenders = files
      .filter((f) => f.relative !== OWNER)
      .flatMap((f) =>
        [...f.source.matchAll(COOKIE_READ)]
          .filter(([, rest]) => !ADMIN_COOKIE_READS.some((read) => rest.trimStart().startsWith(read)))
          .map(([call]) => `${f.relative}: ${call.trim()}`),
      );

    expect(offenders).toEqual([]);
  });

  it('reads the Authorization or raw Cookie header only inside student-session.ts', () => {
    const CREDENTIAL_HEADER_READ = /headers\s*\.\s*get\s*\(\s*['"`](authorization|cookie)['"`]\s*\)/i;
    const offenders = files
      .filter((f) => f.relative !== OWNER && CREDENTIAL_HEADER_READ.test(f.source))
      .map((f) => f.relative);

    expect(offenders).toEqual([]);
  });

  it('lists every route that calls the session guard, apart from the session-optional generate-questions', () => {
    const guardedRoutes = files
      .filter((f) => /^app\/api\/.+\/route\.ts$/.test(f.relative) && f.source.includes('requireStudentSession('))
      .map((f) => f.relative.replace(/^app\/api\//, '').replace(/\/route\.ts$/, ''))
      .filter((name) => name !== 'generate-questions');

    expect(guardedRoutes.sort()).toEqual(ALWAYS_GUARDED.map((r) => r.name).sort());
  });
});
