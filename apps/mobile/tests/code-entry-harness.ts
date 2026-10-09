import { vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createMemoryStudyCodeStore, type StudyCodeStore } from '../src/auth/study-code-store';
import { createMemoryTokenStore, observeTokenStore, type TokenStore } from '../src/auth/token-store';
import type { ApiConfig } from '../src/config';
import { createCodeEntryStore } from '../src/features/code-entry/code-entry-store';
import { createSessionStore } from '../src/features/code-entry/session-store';

const config: ApiConfig = {
  profile: 'development',
  baseUrl: 'http://localhost:3000',
  origin: 'http://localhost:3000',
};

export const DETAILS = {
  id: '6f1c2b8e-0000-4000-8000-000000000001',
  code: 'brave purple penguin',
  display_name: null,
  created_at: '2026-10-01T12:00:00Z',
  total_quizzes: 0,
  total_questions: 0,
  correct_answers: 0,
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

type Responder = (init: RequestInit) => Response | Promise<Response>;

interface SetupOptions {
  token?: string | null;
  code?: string | null;
  /** Replaces methods of the in-memory token store, to make storage fail. */
  tokenStore?: Partial<TokenStore>;
  /** Replaces methods of the in-memory study code store, to make storage fail. */
  codeStore?: Partial<StudyCodeStore>;
}

/**
 * The real API client over a mocked fetch, with in-memory token and code stores, wired into the
 * session and code-entry stores the same way `src/services.ts` wires the real ones.
 */
export function setupCodeEntry(options: SetupOptions = {}) {
  const routes = new Map<string, Responder>();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const respond = routes.get(path);
    if (!respond) throw new Error(`no mocked response for ${path}`);
    return respond(init);
  });
  const tokenStore = observeTokenStore({ ...createMemoryTokenStore(options.token ?? null), ...options.tokenStore });
  const codeStore = { ...createMemoryStudyCodeStore(options.code ?? null), ...options.codeStore };
  const client = createApiClient({ config, tokenStore, fetch });
  const session = createSessionStore({ client, tokenStore, codeStore });
  const codeEntry = createCodeEntryStore({ client, session });

  const callsTo = (path: string) =>
    fetch.mock.calls
      .filter(([url]) => new URL(url).pathname === path)
      .map(([, init]) => ({ init, body: init.body ? JSON.parse(String(init.body)) : undefined }));

  return {
    fetch,
    tokenStore,
    codeStore,
    client,
    session,
    codeEntry,
    callsTo,
    on: (path: string, respond: Responder) => routes.set(path, respond),
  };
}

/** A promise with its resolver, for holding a mocked response in flight. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
