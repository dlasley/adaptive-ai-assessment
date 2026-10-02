import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The anon Supabase client (`supabase` in apps/web/src/lib/supabase.ts) may only read the public
// learning resources. Student tables and the question bank are reached through the service-role
// client in server routes. This test reads the sources whole, so a `.from(...)` chain split across
// lines is caught the same as one written on a single line.

const webSrc = path.resolve(__dirname, '../apps/web/src');

/** Files that may import the anon `supabase` client itself. */
const ANON_CLIENT_USERS = [
  'lib/supabase.ts',
  'lib/learning-resources-client.ts',
  'app/api/study-guide/route.ts',
];

const GUARDED_TABLES = ['questions', 'units', 'study_codes', 'quiz_history', 'question_results', 'leitner_state'];

const ANON_CHAIN = new RegExp(
  String.raw`\bsupabase\s*!?\s*\.\s*from\s*\(\s*['"\`](?:${GUARDED_TABLES.join('|')})['"\`]`
);

const ANON_IMPORT = /import\s*(type\s*)?\{([^}]*)\}\s*from\s*['"](?:@\/lib\/|\.\/|\.\.\/lib\/)supabase['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function chainsGuardedTable(source: string): boolean {
  return ANON_CHAIN.test(source);
}

function importsAnonClient(source: string): boolean {
  for (const match of source.matchAll(ANON_IMPORT)) {
    if (match[1]) continue;
    const names = match[2].split(',').map((n) => n.trim());
    if (names.some((n) => n === 'supabase')) return true;
  }
  return false;
}

describe('anon Supabase client boundary', () => {
  const files = sourceFiles(webSrc).map((file) => ({
    relative: path.relative(webSrc, file).split(path.sep).join('/'),
    source: readFileSync(file, 'utf-8'),
  }));

  it('finds the app sources', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never chains .from() on a guarded table through the anon client, on one line or several', () => {
    const offenders = files.filter((f) => chainsGuardedTable(f.source)).map((f) => f.relative);
    expect(offenders).toEqual([]);
  });

  it('imports the anon client only in the allowed files', () => {
    const offenders = files
      .filter((f) => importsAnonClient(f.source) && !ANON_CLIENT_USERS.includes(f.relative))
      .map((f) => f.relative);
    expect(offenders).toEqual([]);
  });

  describe('detection', () => {
    it('catches a chain split across lines', () => {
      expect(chainsGuardedTable("const r = await supabase!\n    .from('questions')\n    .select('*');")).toBe(true);
      expect(chainsGuardedTable('supabase\n  .from(\n  "study_codes")')).toBe(true);
    });

    it('does not flag the service-role client or a public table', () => {
      expect(chainsGuardedTable("supabaseAdmin!\n  .from('questions')")).toBe(false);
      expect(chainsGuardedTable("supabase.from('learning_resources')")).toBe(false);
    });

    it('catches a value import of the anon client and ignores type imports', () => {
      expect(importsAnonClient("import { supabase, isSupabaseAvailable } from '@/lib/supabase';")).toBe(true);
      expect(importsAnonClient("import {\n  supabase,\n} from './supabase';")).toBe(true);
      expect(importsAnonClient("import type { QuizHistory } from '@/lib/supabase';")).toBe(false);
      expect(importsAnonClient("import { supabaseAdmin } from '@/lib/supabase-admin';")).toBe(false);
    });
  });
});
