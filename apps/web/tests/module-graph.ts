import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CREDENTIAL_ENV_VARS } from '../../../tests/credential-guard';

export const webSrc = path.resolve(__dirname, '../src');
const sharedSrc = path.resolve(__dirname, '../../../packages/shared/src');

// Static imports and re-exports, dynamic imports, and side-effect imports (`import 'x'`).
const IMPORT_SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

// Every credential the test setup strips; one list, kept in tests/credential-guard.ts.
const SECRET_NAMES = new RegExp(CREDENTIAL_ENV_VARS.join('|'));

function resolveLocalImport(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(webSrc, specifier.slice(2));
  else if (specifier.startsWith('@adaptive/shared/')) base = path.join(sharedSrc, specifier.slice('@adaptive/shared/'.length));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  if (/\.css$/.test(base)) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not resolve ${specifier} from ${fromFile}`);
}

/**
 * Every source file reachable from `entry` through local imports: the `@/` alias,
 * `@adaptive/shared/*` and relative paths. Package imports such as `next/server` are not followed.
 */
export function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf-8').matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveLocalImport(match[1] ?? match[2] ?? match[3], file);
      if (resolved) pending.push(resolved);
    }
  }
  return [...seen];
}

/** Files in `files` whose source names any credential environment variable. */
export function filesNamingSecrets(files: string[]): string[] {
  return files.filter((file) => SECRET_NAMES.test(readFileSync(file, 'utf-8')));
}
