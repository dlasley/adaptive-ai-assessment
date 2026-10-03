import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: path.resolve(import.meta.dirname, '../../node_modules/.vite/mobile'),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [path.resolve(import.meta.dirname, '../../tests/setup.ts')],
  },
  resolve: {
    alias: {
      // The real module calls into native code through react-native, which cannot load under Node.
      'expo-secure-store': path.resolve(import.meta.dirname, './tests/stubs/expo-secure-store.ts'),
    },
  },
});
