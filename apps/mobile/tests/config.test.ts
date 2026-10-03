import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApiConfig, resolveApiConfig } from '../src/config';

describe('resolveApiConfig', () => {
  it('defaults an unset base URL to next dev when the profile is unset (expo start, Expo Go)', () => {
    expect(resolveApiConfig({})).toEqual({
      profile: 'development',
      baseUrl: 'http://localhost:3000',
      origin: 'http://localhost:3000',
    });
  });

  it('defaults an unset base URL in the development profile', () => {
    expect(resolveApiConfig({ profile: 'development', baseUrl: '' }).baseUrl).toBe('http://localhost:3000');
  });

  it.each(['preview', 'production'])('refuses an unset base URL in the %s profile', (profile) => {
    expect(() => resolveApiConfig({ profile })).toThrow(
      `EXPO_PUBLIC_API_BASE_URL is not set for the "${profile}" build profile. ` +
        'Set it in the EAS environment this profile uses, for example https://pratique.amazingzebra.com.',
    );
  });

  it.each(['preview', 'production'])('refuses a plain-http base URL in the %s profile', (profile) => {
    expect(() => resolveApiConfig({ profile, baseUrl: 'http://pratique.amazingzebra.com' })).toThrow(
      `EXPO_PUBLIC_API_BASE_URL must use https in the "${profile}" build profile; got "http://pratique.amazingzebra.com".`,
    );
  });

  it('allows plain http in development, for next dev on the LAN', () => {
    expect(resolveApiConfig({ profile: 'development', baseUrl: 'http://192.168.1.20:3000' }).baseUrl).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('derives the Origin header from the base URL and drops a trailing slash', () => {
    expect(
      resolveApiConfig({ profile: 'production', baseUrl: 'https://pratique.amazingzebra.com/' }),
    ).toEqual({
      profile: 'production',
      baseUrl: 'https://pratique.amazingzebra.com',
      origin: 'https://pratique.amazingzebra.com',
    });
  });

  it('sends the Origin override when one is set', () => {
    const config = resolveApiConfig({ baseUrl: 'http://192.168.1.20:3000', origin: 'http://localhost:3000' });
    expect(config.baseUrl).toBe('http://192.168.1.20:3000');
    expect(config.origin).toBe('http://localhost:3000');
  });

  it('rejects an unknown profile and a malformed URL with a readable message', () => {
    expect(() => resolveApiConfig({ profile: 'prod' })).toThrow(
      'EXPO_PUBLIC_APP_PROFILE is "prod"; expected one of development, preview, production.',
    );
    expect(() => resolveApiConfig({ baseUrl: 'pratique.amazingzebra.com' })).toThrow(
      'EXPO_PUBLIC_API_BASE_URL is not a valid URL: "pratique.amazingzebra.com".',
    );
  });
});

describe('loadApiConfig', () => {
  it('returns the config, or the readable reason there is none instead of throwing', () => {
    expect(loadApiConfig({}).error).toBeNull();
    expect(loadApiConfig({ profile: 'preview' })).toEqual({
      config: null,
      error:
        'EXPO_PUBLIC_API_BASE_URL is not set for the "preview" build profile. ' +
        'Set it in the EAS environment this profile uses, for example https://pratique.amazingzebra.com.',
    });
  });
});

describe('apiConfigLoad at module load', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('records the refusal when the bundle loads in the preview profile without a base URL', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_PROFILE', 'preview');
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', '');
    vi.resetModules();
    const { apiConfigLoad } = await import('../src/config');
    expect(apiConfigLoad.config).toBeNull();
    expect(apiConfigLoad.error).toContain('EXPO_PUBLIC_API_BASE_URL is not set for the "preview" build profile.');
  });

  it('reads the inlined variables when they are set', async () => {
    vi.stubEnv('EXPO_PUBLIC_APP_PROFILE', 'production');
    vi.stubEnv('EXPO_PUBLIC_API_BASE_URL', 'https://pratique.amazingzebra.com');
    vi.stubEnv('EXPO_PUBLIC_API_ORIGIN', '');
    vi.resetModules();
    const { apiConfigLoad } = await import('../src/config');
    expect(apiConfigLoad).toEqual({
      config: {
        profile: 'production',
        baseUrl: 'https://pratique.amazingzebra.com',
        origin: 'https://pratique.amazingzebra.com',
      },
      error: null,
    });
  });
});
