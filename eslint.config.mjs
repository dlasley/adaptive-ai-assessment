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

// The Expo app keeps the React, React hooks and TypeScript rules eslint-config-next supplies to
// every file, and drops the rules that only make sense for a Next.js app.
const nextRulesOff = Object.fromEntries(
  nextVitals
    .flatMap((config) => Object.keys(config.rules ?? {}))
    .filter((rule) => rule.startsWith('@next/next/'))
    .map((rule) => [rule, 'off']),
);

const eslintConfig = defineConfig([
  ...nextVitalsFromWebRoot,
  {
    files: ['apps/mobile/**/*.{ts,tsx,js,mjs,cjs,mts}'],
    rules: {
      ...nextRulesOff,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs,mts}'],
    plugins: { unicorn: eslintPluginUnicorn },
    rules: {
      'unicorn/filename-case': [
        'error',
        {
          case: 'kebabCase',
          // The rule checks directory names as well as file names. Next.js
          // reads a dynamic route segment's directory name (`[unitId]/`) as the
          // route parameter, and Expo Router reads a `[param].tsx` file name the
          // same way, so both must stay valid identifiers rather than
          // kebab-case. The rule already skips the `_`, `+` and parenthesis
          // characters, so `_layout.tsx`, `+not-found.tsx` and `(group)/`
          // pass on the kebab-case words inside them.
          ignore: [/^\[.*\]$/, /^\[.*\]\.tsx?$/],
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
    'apps/mobile/.expo/**',
    'apps/mobile/dist/**',
    'apps/mobile/expo-env.d.ts',
    'apps/mobile/ios/**',
    'apps/mobile/android/**',
    'apps/pipeline/archive/**',
    'apps/pipeline/content/pdf/**',
    'apps/pipeline/content/markdown/**',
    'apps/pipeline/content/exports/**',
  ]),
]);

export default eslintConfig;
