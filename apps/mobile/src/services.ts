/**
 * The app's single API client and session state, built once when the bundle loads. Null when the
 * configuration failed to load, in which case the root layout shows the reason instead of a route.
 */

import { createApiClient, type ApiClient } from './api/client';
import { createSecureStudyCodeStore } from './auth/study-code-store';
import { createSecureTokenStore, observeTokenStore } from './auth/token-store';
import { apiConfigLoad, type ApiConfig } from './config';
import { createCodeEntryStore, type CodeEntryStore } from './features/code-entry/code-entry-store';
import { createSessionStore, type SessionStore } from './features/code-entry/session-store';

interface Services {
  config: ApiConfig;
  client: ApiClient;
  session: SessionStore;
  codeEntry: CodeEntryStore;
}

function createServices(config: ApiConfig): Services {
  const tokenStore = observeTokenStore(createSecureTokenStore());
  const client = createApiClient({ config, tokenStore });
  const session = createSessionStore({ client, tokenStore, codeStore: createSecureStudyCodeStore() });
  const codeEntry = createCodeEntryStore({ client, session });
  return { config, client, session, codeEntry };
}

export const services: Services | null = apiConfigLoad.config ? createServices(apiConfigLoad.config) : null;
