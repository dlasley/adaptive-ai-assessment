import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type ApiClient, type CourseResponse } from '../src/api/client';
import { createMemoryTokenStore } from '../src/auth/token-store';
import type { ApiConfig } from '../src/config';

const config: ApiConfig = {
  profile: 'production',
  baseUrl: 'https://pratique.amazingzebra.com',
  origin: 'https://pratique.amazingzebra.com',
};

const course: CourseResponse = {
  course: {
    name: 'French II',
    title: 'French II Practice & Assessment',
    language: 'French',
    nativeLanguageName: 'Français',
    icon: null,
    specialCharacters: ['é'],
  },
  features: { leitner: false },
  limits: { maxQuestions: 50, wrongAnswerCountdownSeconds: 15, wrongAnswerMinWaitSeconds: 3 },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(respond: () => Response, token: string | null = null) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => respond());
  const tokenStore = createMemoryTokenStore(token);
  const client = createApiClient({ config, tokenStore, fetch });
  const lastCall = () => {
    const [url, init] = fetch.mock.calls.at(-1)!;
    return { url, init, headers: init.headers as Record<string, string> };
  };
  return { client, tokenStore, fetch, lastCall };
}

describe('API client request shape', () => {
  it('GETs the course with Origin, no cookies and no Content-Type', async () => {
    const { client, lastCall } = setup(() => jsonResponse(200, course));

    await expect(client.getCourse()).resolves.toEqual(course);

    const { url, init, headers } = lastCall();
    expect(url).toBe('https://pratique.amazingzebra.com/api/course');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBeUndefined();
    expect(headers).toEqual({ Origin: 'https://pratique.amazingzebra.com' });
  });

  it('returns the bare units array', async () => {
    const units = [{ id: 'unit-1', title: 'Unit 1', label: null, description: 'd', topics: [], sort_order: 1 }];
    const { client, lastCall } = setup(() => jsonResponse(200, units));

    await expect(client.getUnits()).resolves.toEqual(units);
    expect(lastCall().url).toBe('https://pratique.amazingzebra.com/api/units');
  });

  it('sends a stored token as a bearer', async () => {
    const { client, lastCall } = setup(() => jsonResponse(200, course), 'signed.token');

    await client.getCourse();
    expect(lastCall().headers.Authorization).toBe('Bearer signed.token');
  });

  it('POSTs logout as JSON with Origin and returns status and body', async () => {
    const { client, lastCall } = setup(() => jsonResponse(200, { success: true }));

    await expect(client.logout()).resolves.toEqual({ status: 200, body: { success: true } });

    const { url, init, headers } = lastCall();
    expect(url).toBe('https://pratique.amazingzebra.com/api/student/logout');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe('{}');
    expect(headers).toEqual({
      Origin: 'https://pratique.amazingzebra.com',
      'Content-Type': 'application/json',
    });
  });

  it('leaves Origin out when asked and resolves with the 403 rather than throwing', async () => {
    const { client, lastCall } = setup(() => jsonResponse(403, { error: 'Origin not allowed' }));

    await expect(client.logout({ omitOrigin: true })).resolves.toEqual({
      status: 403,
      body: { error: 'Origin not allowed' },
    });
    expect(lastCall().headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('throws ApiError with the status and body when a GET fails, keeping a non-JSON body as text', async () => {
    const { client } = setup(() => new Response('<html>Bad gateway</html>', { status: 502 }));

    const error = await client.getCourse().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ path: '/api/course', status: 502, body: '<html>Bad gateway</html>' });
  });
});

describe('API client token clearing', () => {
  const routes: [string, (client: ApiClient) => Promise<unknown>][] = [
    ['GET /api/course', (client) => client.getCourse()],
    ['GET /api/units', (client) => client.getUnits()],
    ['POST /api/student/logout', (client) => client.logout()],
  ];

  it.each(routes)('clears the stored token on a 401 from %s', async (_route, call) => {
    const { client, tokenStore } = setup(() => jsonResponse(401, { error: 'Unauthorized' }), 'stale.token');

    await call(client).catch(() => undefined);
    expect(await tokenStore.get()).toBeNull();
  });

  it('keeps a token stored while the rejected request was in flight', async () => {
    const tokenStore = createMemoryTokenStore('T1');
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      await tokenStore.set('T2');
      return jsonResponse(401, { error: 'Unauthorized' });
    });
    const client = createApiClient({ config, tokenStore, fetch });

    await client.getCourse().catch(() => undefined);
    expect((fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer T1');
    expect(await tokenStore.get()).toBe('T2');
  });

  it('does not clear a token stored after an anonymous request was rejected', async () => {
    const tokenStore = createMemoryTokenStore();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => {
      await tokenStore.set('T2');
      return jsonResponse(401, { error: 'Unauthorized' });
    });
    const client = createApiClient({ config, tokenStore, fetch });

    await client.logout();
    expect(await tokenStore.get()).toBe('T2');
  });

  it.each([403, 429, 500])('keeps the stored token on a %i', async (status) => {
    const { client, tokenStore } = setup(() => jsonResponse(status, { error: 'x' }), 'good.token');

    await client.getCourse().catch(() => undefined);
    await client.logout();
    expect(await tokenStore.get()).toBe('good.token');
  });
});

describe('API client study code and session routes', () => {
  const details = {
    id: 'id-1',
    code: 'brave purple penguin',
    display_name: null,
    created_at: '2026-10-01T12:00:00Z',
    total_quizzes: 0,
    total_questions: 0,
    correct_answers: 0,
  };

  it('verifies a code as a native caller and stores the returned token', async () => {
    const { client, tokenStore, lastCall } = setup(() =>
      jsonResponse(200, { exists: true, details, token: 'minted.token' }),
    );

    await expect(client.verifyCode('brave purple penguin')).resolves.toEqual({
      ok: true,
      body: { exists: true, details, token: 'minted.token' },
    });
    const { url, init, headers } = lastCall();
    expect(url).toBe('https://pratique.amazingzebra.com/api/verify-code');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'brave purple penguin', platform: 'native' });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Origin).toBe('https://pratique.amazingzebra.com');
    expect(await tokenStore.get()).toBe('minted.token');
  });

  it('stores nothing when the code does not exist', async () => {
    const { client, tokenStore } = setup(() => jsonResponse(200, { exists: false }));

    await expect(client.verifyCode('nope')).resolves.toEqual({ ok: true, body: { exists: false } });
    expect(await tokenStore.get()).toBeNull();
  });

  it('returns a refusal with its status, body and Retry-After in whole seconds', async () => {
    const challenge = { error: 'Verification required', turnstileRequired: true, turnstileSiteKey: 'k' };
    const { client } = setup(() => jsonResponse(403, challenge, { 'Retry-After': '119.2' }));

    await expect(client.verifyCode('brave purple penguin')).resolves.toEqual({
      ok: false,
      status: 403,
      body: challenge,
      retryAfterSeconds: 120,
    });
  });

  it.each([null, '0', 'Wed, 21 Oct 2026 07:28:00 GMT'])('reports no wait for a Retry-After of %s', async (value) => {
    const { client } = setup(() =>
      jsonResponse(429, { error: 'x' }, value === null ? {} : { 'Retry-After': value }),
    );

    await expect(client.verifyCode('brave purple penguin')).resolves.toMatchObject({ retryAfterSeconds: null });
  });

  it('generates a code as a native caller and stores the returned token', async () => {
    const { client, tokenStore, lastCall } = setup(() =>
      jsonResponse(200, { code: 'calm green otter', token: 'minted.token' }),
    );

    await expect(client.generateCode()).resolves.toEqual({
      ok: true,
      body: { code: 'calm green otter', token: 'minted.token' },
    });
    expect(lastCall().url).toBe('https://pratique.amazingzebra.com/api/generate-code');
    expect(JSON.parse(String(lastCall().init.body))).toEqual({ platform: 'native' });
    expect(await tokenStore.get()).toBe('minted.token');
  });

  it('stores nothing when generating fails', async () => {
    const { client, tokenStore } = setup(() => jsonResponse(503, { error: 'Service unavailable' }));

    await expect(client.generateCode()).resolves.toMatchObject({ ok: false, status: 503 });
    expect(await tokenStore.get()).toBeNull();
  });

  it('asks for the session with the stored bearer', async () => {
    const { client, lastCall } = setup(() => jsonResponse(200, { authenticated: true }), 'held.token');

    await expect(client.getSession()).resolves.toEqual({ authenticated: true });
    expect(lastCall().url).toBe('https://pratique.amazingzebra.com/api/student/session');
    expect(lastCall().init.method).toBe('GET');
    expect(lastCall().headers.Authorization).toBe('Bearer held.token');
  });
});
