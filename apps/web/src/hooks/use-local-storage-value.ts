'use client';

import { useSyncExternalStore } from 'react';

const LOCAL_WRITE_EVENT = 'local-storage-write';

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(LOCAL_WRITE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(LOCAL_WRITE_EVENT, onStoreChange);
  };
}

/**
 * Reads a value derived from localStorage (and/or other client-only globals
 * such as `window.innerWidth`) without a hydration mismatch: React uses
 * `getServerSnapshot` for the server-rendered and first client render, then
 * switches to `getSnapshot` and re-renders if it differs.
 *
 * Re-renders when the underlying value changes in another tab (the native
 * `storage` event, which never fires in the tab that made the write) or in
 * this tab, via `notifyLocalStorageWrite`.
 */
export function useLocalStorageValue<T>(getSnapshot: () => T, getServerSnapshot: () => T): T {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Call after writing to localStorage so subscribers in the same tab pick up
 * the change; the native `storage` event only reaches other tabs.
 */
export function notifyLocalStorageWrite(): void {
  window.dispatchEvent(new Event(LOCAL_WRITE_EVENT));
}
