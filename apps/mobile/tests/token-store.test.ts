import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryTokenStore,
  createSecureTokenStore,
  observeTokenStore,
  type TokenStore,
} from '../src/auth/token-store';
import { items } from './stubs/expo-secure-store';

describe.each<[string, () => TokenStore]>([
  ['memory', () => createMemoryTokenStore()],
  ['secure', () => createSecureTokenStore()],
])('%s token store', (_name, create) => {
  beforeEach(() => {
    items.clear();
  });

  it('is empty until a token is set', async () => {
    expect(await create().get()).toBeNull();
  });

  it('returns the token it was given', async () => {
    const store = create();
    await store.set('signed.token');
    expect(await store.get()).toBe('signed.token');
  });

  it('replaces a previous token', async () => {
    const store = create();
    await store.set('first');
    await store.set('second');
    expect(await store.get()).toBe('second');
  });

  it('forgets the token on clear, and clearing an empty store is not an error', async () => {
    const store = create();
    await store.set('signed.token');
    await store.clear();
    expect(await store.get()).toBeNull();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('clearIf removes only the expected token', async () => {
    const store = create();
    await store.set('newer');
    await store.clearIf('older');
    expect(await store.get()).toBe('newer');
    await store.clearIf('newer');
    expect(await store.get()).toBeNull();
  });
});

describe('secure token store', () => {
  it('keeps the token under one SecureStore key made of permitted characters', async () => {
    items.clear();
    await createSecureTokenStore().set('signed.token');
    expect([...items.keys()]).toEqual(['student-session-token']);
    expect([...items.keys()][0]).toMatch(/^[\w.-]+$/);
  });
});

describe('observed token store', () => {
  it('tells subscribers whether a token is stored after each write, until they unsubscribe', async () => {
    const store = observeTokenStore(createMemoryTokenStore());
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe((hasToken) => seen.push(hasToken));

    await store.set('first');
    await store.clearIf('other');
    await store.clearIf('first');
    await store.set('second');
    await store.clear();
    unsubscribe();
    await store.set('third');

    expect(seen).toEqual([true, true, false, true, false]);
    expect(await store.get()).toBe('third');
  });
});
