/**
 * Typed client for the web app's `/api/*` routes.
 *
 * Every request sends `Origin: <api origin>` and `credentials: 'omit'`; POSTs also send
 * `Content-Type: application/json`. The server's CSRF check accepts a request only when both
 * headers match its allow-list, and the app holds no cookies, so `Origin` is what identifies it.
 * A stored session token goes out as `Authorization: Bearer <token>`. A 401 from any route clears
 * the stored token, because the server answers 401 only when the session it was given is no longer
 * valid. Only the token that request sent is cleared, so a token stored while it was in flight
 * survives.
 *
 * Response types mirror what the routes in `apps/web/src/app/api/` return. They are declared here
 * rather than imported, since the app never imports web-app modules.
 */

import type { ApiConfig } from '../config';
import type { TokenStore } from '../auth/token-store';

/** `GET /api/course`. */
export interface CourseResponse {
  course: {
    name: string;
    title: string;
    language: string;
    nativeLanguageName: string;
    icon: string | null;
    specialCharacters: string[];
  };
  features: {
    leitner: boolean;
  };
  limits: {
    maxQuestions: number;
    wrongAnswerCountdownSeconds: number;
    wrongAnswerMinWaitSeconds: number;
  };
}

type TopicHeadingRef = string | { heading: string; slide: number };

/** One row of `GET /api/units`, which returns a bare array of these in `sort_order`. */
interface UnitRow {
  id: string;
  title: string;
  label: string | null;
  description: string;
  topics: { name: string; headings: TopicHeadingRef[] }[];
  sort_order: number;
}

/** Status and parsed body of a response, returned as-is whatever the status. */
export interface ApiResponse {
  status: number;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${path} answered ${status}`);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  /**
   * Leaves out the `Origin` header. Used only by the smoke screen's negative check that the
   * server refuses a POST without it.
   */
  omitOrigin?: boolean;
}

export interface ApiClientDeps {
  config: ApiConfig;
  tokenStore: TokenStore;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface ApiClient {
  getCourse(): Promise<CourseResponse>;
  getUnits(): Promise<UnitRow[]>;
  /** Clears the web session cookie. Resolves with any status, so a caller can show a 403. */
  logout(options?: RequestOptions): Promise<ApiResponse>;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createApiClient({ config, tokenStore, fetch: fetchImpl = fetch }: ApiClientDeps): ApiClient {
  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {};
    if (!options.omitOrigin) headers.Origin = config.origin;
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    const token = await tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers,
      credentials: 'omit',
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    });

    if (response.status === 401 && token) await tokenStore.clearIf(token);

    return { status: response.status, body: await readBody(response) };
  }

  async function getJson<T>(path: string): Promise<T> {
    const { status, body } = await request('GET', path, undefined);
    if (status < 200 || status >= 300) throw new ApiError(path, status, body);
    return body as T;
  }

  return {
    getCourse: () => getJson<CourseResponse>('/api/course'),
    getUnits: () => getJson<UnitRow[]>('/api/units'),
    logout: (options) => request('POST', '/api/student/logout', {}, options),
  };
}
