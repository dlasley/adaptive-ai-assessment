/**
 * Where the app sends API requests, resolved once when the bundle loads.
 *
 * Expo inlines an `EXPO_PUBLIC_*` variable into the bundle at build time only when it is written
 * as the literal `process.env.EXPO_PUBLIC_NAME`, so each one is read below by its full name and
 * never through a computed key or destructuring. Every value here ships inside the app and is
 * public.
 *
 * - `EXPO_PUBLIC_API_BASE_URL`: origin of the web deployment, e.g. `https://pratique.amazingzebra.com`.
 * - `EXPO_PUBLIC_API_ORIGIN` (optional): the `Origin` header the server's CSRF allow-list expects.
 *   Defaults to the base URL's origin. Set it only when the two differ, as for a physical device
 *   reaching `next dev` at the Mac's LAN address, which must still present `http://localhost:3000`.
 * - `EXPO_PUBLIC_APP_PROFILE`: the build profile. Each build profile in `eas.json` sets it.
 *   `expo start` and Expo Go run no EAS profile, so an unset value means `development`.
 *
 * In `development` an unset base URL falls back to `http://localhost:3000`, where `next dev`
 * listens. In `preview` and `production` the base URL must be set and use https; otherwise the
 * app opens on a screen naming the problem instead of quietly calling localhost.
 */

const APP_PROFILES = ['development', 'preview', 'production'] as const;
type AppProfile = (typeof APP_PROFILES)[number];

export interface ApiConfig {
  profile: AppProfile;
  /** No trailing slash; request paths begin with `/api/`. */
  baseUrl: string;
  origin: string;
}

export interface ApiConfigEnv {
  baseUrl?: string;
  origin?: string;
  profile?: string;
}

const DEVELOPMENT_BASE_URL = 'http://localhost:3000';

function isAppProfile(value: string): value is AppProfile {
  return (APP_PROFILES as readonly string[]).includes(value);
}

function parseUrl(name: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: "${value}".`);
  }
}

export function resolveApiConfig(env: ApiConfigEnv): ApiConfig {
  const profile = env.profile || 'development';
  if (!isAppProfile(profile)) {
    throw new Error(
      `EXPO_PUBLIC_APP_PROFILE is "${profile}"; expected one of ${APP_PROFILES.join(', ')}.`,
    );
  }

  let baseUrl = env.baseUrl;
  if (!baseUrl) {
    if (profile !== 'development') {
      throw new Error(
        `EXPO_PUBLIC_API_BASE_URL is not set for the "${profile}" build profile. ` +
          'Set it in the EAS environment this profile uses, for example https://pratique.amazingzebra.com.',
      );
    }
    baseUrl = DEVELOPMENT_BASE_URL;
  }

  const parsedBase = parseUrl('EXPO_PUBLIC_API_BASE_URL', baseUrl);
  if (profile !== 'development' && parsedBase.protocol !== 'https:') {
    throw new Error(
      `EXPO_PUBLIC_API_BASE_URL must use https in the "${profile}" build profile; got "${baseUrl}".`,
    );
  }
  const origin = parseUrl('EXPO_PUBLIC_API_ORIGIN', env.origin || baseUrl).origin;

  return { profile, baseUrl: baseUrl.replace(/\/+$/, ''), origin };
}

/** A resolved configuration, or the reason there is none, which the root layout shows on screen. */
export type ApiConfigLoad = { config: ApiConfig; error: null } | { config: null; error: string };

export function loadApiConfig(env: ApiConfigEnv): ApiConfigLoad {
  try {
    return { config: resolveApiConfig(env), error: null };
  } catch (error) {
    return { config: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export const apiConfigLoad: ApiConfigLoad = loadApiConfig({
  baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  origin: process.env.EXPO_PUBLIC_API_ORIGIN,
  profile: process.env.EXPO_PUBLIC_APP_PROFILE,
});
