import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [path.resolve(import.meta.dirname, '../../tests/setup.ts')],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      // Next's bundler no-ops this package on the server graph; outside that
      // bundler it throws unconditionally, so tests get a stub instead.
      'server-only': path.resolve(import.meta.dirname, './tests/stubs/server-only.ts'),
    },
  },
});
