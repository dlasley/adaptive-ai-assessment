/**
 * Storage for the student's study code, so the app can show it after a restart and offer it again
 * when the session ends. The code is all anyone needs to sign in as the student, so it is kept in
 * the Keychain beside the session token.
 */

import * as SecureStore from 'expo-secure-store';

export interface StudyCodeStore {
  get(): Promise<string | null>;
  set(code: string): Promise<void>;
  clear(): Promise<void>;
}

/** SecureStore keys may contain only alphanumerics, `.`, `-` and `_`. */
const STUDY_CODE_KEY = 'student-study-code';

export function createSecureStudyCodeStore(): StudyCodeStore {
  return {
    get: () => SecureStore.getItemAsync(STUDY_CODE_KEY),
    set: (code) => SecureStore.setItemAsync(STUDY_CODE_KEY, code),
    clear: () => SecureStore.deleteItemAsync(STUDY_CODE_KEY),
  };
}

export function createMemoryStudyCodeStore(initial: string | null = null): StudyCodeStore {
  let code = initial;
  return {
    get: async () => code,
    set: async (value) => {
      code = value;
    },
    clear: async () => {
      code = null;
    },
  };
}
