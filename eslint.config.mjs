import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

// The Next.js app moved to apps/web/ — the @next/eslint-plugin-next rules that
// inspect the page/app directory (e.g. no-html-link-for-pages) need to be told
// where it lives now that this config's own directory (the repo root) isn't it.
const nextVitalsFromWebRoot = nextVitals.map((config) => ({
  ...config,
  settings: {
    ...config.settings,
    next: { ...config.settings?.next, rootDir: 'apps/web/' },
  },
}));

const eslintConfig = defineConfig([
  ...nextVitalsFromWebRoot,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs,mts}'],
    plugins: { unicorn: eslintPluginUnicorn },
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
          // Next.js reads a dynamic route segment's directory name as the
          // route parameter (`params.unitId`), so it must be a valid
          // identifier rather than kebab-case.
          ignore: [/^\[.*\]$/],
        },
      ],
    },
  },
  globalIgnores([
    '**/.next/**',
    'out/**',
    'build/**',
    'coverage/**',
    '**/node_modules/**',
    '.private/**',
    'apps/pipeline/archive/**',
    'apps/pipeline/content/pdf/**',
    'apps/pipeline/content/markdown/**',
    'apps/pipeline/content/exports/**',
  ]),
]);

export default eslintConfig;
