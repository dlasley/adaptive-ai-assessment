import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards against retired vocabulary (renamed DB columns/functions, retired
// module paths, retired admin identifiers) silently returning to tracked
// source. Each rule below carries its own reason for the name's retirement.

const repoRoot = path.resolve(__dirname, '..');

function trackedFiles(pathspecs: string[]): string[] {
  // execFileSync bypasses the shell, so git (not the local shell's globbing)
  // resolves the pathspecs. The `:(glob)` magic makes `**` recurse the way
  // callers expect; plain `git ls-files '*.ts'` only matches one path segment.
  const output = execFileSync(
    'git',
    ['ls-files', '--', ...pathspecs.map((p) => `:(glob)${p}`)],
    { cwd: repoRoot, encoding: 'utf-8' }
  );
  return output.split('\n').filter(Boolean);
}

// apps/web/src, apps/pipeline, and packages/shared/src are the app, pipeline, and shared
// code where identifiers live; supabase/schema.sql is where the DB-only renames (trigger
// function, index prefix, boolean columns) live. Tests are excluded so this file's own
// examples don't self-trigger.
const allSourceFiles = trackedFiles([
  'apps/web/src/**/*.ts',
  'apps/web/src/**/*.tsx',
  'apps/pipeline/**/*.ts',
  'packages/shared/src/**/*.ts',
]).filter((f) => !f.endsWith('.test.ts'));
const schemaFile = 'supabase/schema.sql';

// Same file set plus the pipeline's prompt templates (course-identity.test.ts's own
// rule needs these; the rules above don't since no retired name lives in a .md file).
// packages/shared/src/course.ts is excluded — it's the one place allowed to name a course,
// as the dev-only fallback for COURSE_NAME/COURSE_TITLE when those env vars aren't set.
const courseIdentityFiles = trackedFiles([
  'apps/web/src/**/*.ts',
  'apps/web/src/**/*.tsx',
  'apps/pipeline/**/*.ts',
  'apps/pipeline/prompts/*.md',
  'packages/shared/src/**/*.ts',
]).filter((f) => !f.endsWith('.test.ts') && f !== 'packages/shared/src/course.ts');

interface GlossaryRule {
  name: string;
  reason: string;
  pattern: RegExp;
  files: string[];
  /** Strings that must NOT match `pattern`, proving it isn't overly broad. */
  currentOk: string[];
  /** A string that MUST match `pattern`, proving it isn't dead. */
  retiredExample: string;
}

const rules: GlossaryRule[] = [
  {
    name: 'admin "student" naming for the study-code entity',
    reason:
      'the DB table is study_codes; the admin surface renamed its identifiers and route to match, keeping "Student" only as end-user-facing UI copy',
    pattern: /\b(getAllStudents|searchStudents|StudentSummary|StudentDetailedProgress|deleteStudents?)\b|\/admin\/students(?:['"`/]|\s|$)/,
    files: allSourceFiles,
    currentOk: [
      'getAllStudyCodes',
      'StudyCodeSummary',
      'StudyCodeDetailedProgress',
      'deleteStudyCode',
      '/api/admin/study-codes',
      '/api/student/dashboard',
      'Total Students',
      'handleDeleteSingleStudyCode',
    ],
    retiredExample: 'getAllStudents',
  },
  {
    name: 'audit-group chunk size (retired BATCH_SIZE)',
    reason:
      'the audit pipeline\'s 5-question LLM chunk size was consolidated to AUDIT_GROUP_SIZE (apps/pipeline/src/lib/pipeline-config.ts) to disambiguate it from the two other "batch" concepts in the codebase (pipeline runs, OpenRouter jobs)',
    pattern: /\bBATCH_SIZE\b/,
    files: allSourceFiles,
    currentOk: ['AUDIT_GROUP_SIZE'],
    retiredExample: 'const BATCH_SIZE = 5;',
  },
  {
    name: 'typed-answer evaluation module (retired writing-questions path)',
    reason:
      'fuzzy-match evaluation logic moved from writing-questions.ts to typed-answer-evaluation.ts because it evaluates both writing and fill-in-blank question types, not writing alone',
    pattern: /writing[-_]questions/i,
    files: allSourceFiles,
    currentOk: ['typed-answer-evaluation', 'WritingQuestionDisplay', 'WritingAnswerInput'],
    retiredExample: "from './lib/writing-questions'",
  },
  {
    name: 'complete-sentence requirement boolean naming',
    reason:
      'renamed to has_complete_sentence_requirement / hasCompleteSentenceRequirement to follow the schema\'s is_/has_ boolean prefix convention',
    pattern: /\brequires_complete_sentence\b|\brequiresCompleteSentence\b/,
    files: [...allSourceFiles, schemaFile],
    currentOk: ['has_complete_sentence_requirement', 'hasCompleteSentenceRequirement'],
    retiredExample: 'requires_complete_sentence',
  },
  {
    name: 'fallback-applied boolean naming',
    reason:
      'renamed to is_fallback_applied to follow the schema\'s is_/has_ boolean prefix convention',
    pattern: /(?<!is_)\bfallback_applied\b/,
    files: [...allSourceFiles, schemaFile],
    currentOk: ['is_fallback_applied'],
    retiredExample: 'fallback_applied',
  },
  {
    name: 'shared updated_at trigger function naming',
    reason:
      'renamed from update_questions_updated_at to set_updated_at since the function is reused as the trigger for units and learning_resources, not just questions',
    pattern: /\bupdate_questions_updated_at\b/,
    files: [...allSourceFiles, schemaFile],
    currentOk: ['set_updated_at'],
    retiredExample: 'update_questions_updated_at',
  },
  {
    name: 'learning_resources index prefix abbreviation',
    reason:
      'renamed from the idx_lr_ abbreviation to the full idx_learning_resources_ prefix every other table\'s indexes use',
    pattern: /\bidx_lr_/,
    files: [...allSourceFiles, schemaFile],
    currentOk: ['idx_learning_resources_unit'],
    retiredExample: 'idx_lr_unit',
  },
  {
    name: 'course identity (French I -> French II single-setting migration)',
    reason:
      'the course name/title is centralized in packages/shared/src/course.ts (read from COURSE_NAME/COURSE_TITLE) so switching to a new course, such as a new school year, is a two-env-var change; hard-coding it elsewhere would let the app and pipeline drift out of sync',
    pattern: /\bfrench\s*(?:1|2|i{1,2})\b|first[-\s]year\s+french/i,
    files: courseIdentityFiles,
    currentOk: [
      'getCourse().name',
      'getCourse().title',
      '{{COURSE_NAME}}',
      '{{COURSE_LEVEL}}',
      'renderCoursePrompt',
      // Generic French grammar/vocabulary references with no course-level number attached.
      'French grammar',
      'French language',
      'a French teacher',
    ],
    retiredExample: 'French 1',
  },
];

describe('naming glossary', () => {
  describe.each(rules)('$name', (rule) => {
    it(`does not appear in tracked source (${rule.reason})`, () => {
      const offenders: string[] = [];

      for (const file of rule.files) {
        const content = readFileSync(path.join(repoRoot, file), 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (rule.pattern.test(line)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }

      expect(offenders).toEqual([]);
    });

    it('flags a synthetic reintroduction of the retired name', () => {
      expect(rule.pattern.test(rule.retiredExample)).toBe(true);
    });

    it('does not flag the current replacement vocabulary', () => {
      for (const ok of rule.currentOk) {
        expect(rule.pattern.test(ok)).toBe(false);
      }
    });
  });
});
