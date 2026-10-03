/**
 * Storage for the student session token the server returns to native clients. The token is the
 * same signed value the web app keeps in its cookie, sent back as `Authorization: Bearer`.
 */

import * as SecureStore from 'expo-secure-store';

export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  /** Clears the stored token only if it is still `expected`, leaving a newer one in place. */
  clearIf(expected: string): Promise<void>;
}

/** SecureStore keys may contain only alphanumerics, `.`, `-` and `_`. */
const SESSION_TOKEN_KEY = 'student-session-token';

/**
 * Keychain-backed store. On iOS a Keychain item outlives an uninstall, so reinstalling the app
 * with the same bundle identifier keeps the student signed in.
 */
export function createSecureTokenStore(): TokenStore {
  return {
    get: () => SecureStore.getItemAsync(SESSION_TOKEN_KEY),
    set: (token) => SecureStore.setItemAsync(SESSION_TOKEN_KEY, token),
    clear: () => SecureStore.deleteItemAsync(SESSION_TOKEN_KEY),
    clearIf: async (expected) => {
      if ((await SecureStore.getItemAsync(SESSION_TOKEN_KEY)) === expected) {
        await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
      }
    },
  };
}

export function createMemoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return {
    get: async () => token,
    set: async (value) => {
      token = value;
    },
    clear: async () => {
      token = null;
    },
    clearIf: async (expected) => {
      if (token === expected) token = null;
    },
  };
}
