import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [path.resolve(import.meta.dirname, '../../tests/setup.ts')],
  },
});
