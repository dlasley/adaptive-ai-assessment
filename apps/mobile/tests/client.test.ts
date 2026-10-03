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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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
