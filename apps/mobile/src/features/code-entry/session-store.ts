/**
 * Whether the student is signed in, observable by every screen.
 *
 * The session starts as `restoring` until `restore()` has read the stored token and asked the
 * session route about it. It becomes `signed-out` whenever the token disappears, including when the
 * API client clears it after a 401 from any route, so a screen that watches this store returns to
 * code entry without having made the failing call itself. `code` is the student's study code while
 * signed in, and the code to offer again while signed out (null after "this isn't me").
 *
 * The stored code is cleared before any call that can mint a token and written only after the
 * token is stored, so an interrupted sign-in leaves a token with no code rather than one student's
 * token beside another student's code.
 */

import type { ApiClient } from '../../api/client';
import type { StudyCodeStore } from '../../auth/study-code-store';
import type { ObservedTokenStore } from '../../auth/token-store';

export type SessionState =
  | { phase: 'restoring'; code: null }
  | { phase: 'signed-out'; code: string | null }
  | { phase: 'signed-in'; code: string | null };

export interface SessionStore {
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  /** Runs once per store; later calls return the first run's promise. Never rejects. */
  restore(): Promise<void>;
  /** Clears the stored code ahead of a call that can mint a token. False when storage failed. */
  prepareSignIn(): Promise<boolean>;
  /**
   * Records the code whose session `token` the API client has just stored. When the code cannot
   * be stored, the token is cleared again and this resolves false.
   */
  signIn(code: string, token: string): Promise<boolean>;
  /** "This isn't me": forgets the token and the code. Never rejects. */
  signOut(): Promise<void>;
}

export interface SessionStoreDeps {
  client: Pick<ApiClient, 'getSession'>;
  tokenStore: ObservedTokenStore;
  codeStore: StudyCodeStore;
}

/** Runs each clear, then retries once any that rejected. Never rejects. */
async function clearWithRetry(clears: (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(clears.map((clear) => clear()));
  const failed = clears.filter((_, index) => results[index].status === 'rejected');
  await Promise.allSettled(failed.map((clear) => clear()));
}

export function createSessionStore({ client, tokenStore, codeStore }: SessionStoreDeps): SessionStore {
  let state: SessionState = { phase: 'restoring', code: null };
  let restoring: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function setState(next: SessionState) {
    state = next;
    for (const listener of listeners) listener();
  }

  tokenStore.subscribe((hasToken) => {
    if (!hasToken && state.phase === 'signed-in') setState({ phase: 'signed-out', code: state.code });
  });

  async function runRestore() {
    let token: string | null;
    let code: string | null;
    try {
      [token, code] = await Promise.all([tokenStore.get(), codeStore.get()]);
    } catch {
      setState({ phase: 'signed-out', code: null });
      return;
    }
    if (!token) {
      setState({ phase: 'signed-out', code });
      return;
    }

    let authenticated: boolean;
    try {
      ({ authenticated } = await client.getSession());
    } catch {
      // The session route did not answer, so the token may still be good and the student goes on.
      // The first guarded call the server rejects with a 401 clears it and signs them out.
      setState({ phase: 'signed-in', code });
      return;
    }

    if (authenticated) {
      setState({ phase: 'signed-in', code });
      return;
    }
    try {
      await tokenStore.clearIf(token);
      setState({ phase: 'signed-out', code });
    } catch {
      setState({ phase: 'signed-out', code: null });
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    restore: () => {
      restoring ??= runRestore();
      return restoring;
    },
    prepareSignIn: async () => {
      try {
        await codeStore.clear();
        return true;
      } catch {
        return false;
      }
    },
    signIn: async (code, token) => {
      try {
        await codeStore.set(code);
      } catch {
        await tokenStore.clearIf(token).catch(() => undefined);
        return false;
      }
      setState({ phase: 'signed-in', code });
      return true;
    },
    signOut: async () => {
      // Signed out first, so the token store's clear notification finds nothing left to sign out
      // and the remembered code is not offered back.
      setState({ phase: 'signed-out', code: null });
      await clearWithRetry([() => tokenStore.clear(), () => codeStore.clear()]);
    },
  };
}
