import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryStudyCodeStore,
  createSecureStudyCodeStore,
  type StudyCodeStore,
} from '../src/auth/study-code-store';
import { items } from './stubs/expo-secure-store';

describe.each<[string, () => StudyCodeStore]>([
  ['memory', () => createMemoryStudyCodeStore()],
  ['secure', () => createSecureStudyCodeStore()],
])('%s study code store', (_name, create) => {
  beforeEach(() => {
    items.clear();
  });

  it('keeps a code until it is cleared', async () => {
    const store = create();
    expect(await store.get()).toBeNull();
    await store.set('brave purple penguin');
    expect(await store.get()).toBe('brave purple penguin');
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

describe('secure study code store', () => {
  it('uses its own SecureStore key, apart from the session token', async () => {
    items.clear();
    await createSecureStudyCodeStore().set('brave purple penguin');
    expect([...items.keys()]).toEqual(['student-study-code']);
  });
});
