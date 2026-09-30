import { defineConfig } from 'vitest/config';

// Repo-wide governance tests only (naming glossary, retired-vocabulary guards)
// that scan tracked files across every workspace via `git ls-files` — these
// don't belong to any single workspace, so they get their own root-level
// config rather than living under apps/web or apps/pipeline.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
