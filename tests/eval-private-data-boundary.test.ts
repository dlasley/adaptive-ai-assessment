import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Backs the `.gitignore` rule (`apps/pipeline/reports/`, `apps/pipeline/references/`) with a check, not
// just a convention: eval output — reviewer sheets, reference directories, comparison reports — must
// never land inside the tracked pipeline package, since it can carry course-specific question and
// answer text. See `apps/pipeline/src/lib/eval/paths.ts`'s `guardTrackedTreeWrite`, which refuses
// the write at the source; this is the belt-and-suspenders check on what actually got committed —
// it can only ever see a file already in a commit, not a write the guard refused to make.

const repoRoot = path.resolve(__dirname, '..');

function trackedFiles(pathspecs: string[]): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--', ...pathspecs.map((p) => `:(glob)${p}`)],
    { cwd: repoRoot, encoding: 'utf-8' }
  );
  return output.split('\n').filter(Boolean);
}

describe('eval framework private-data boundary', () => {
  it('no tracked file sits under apps/pipeline/reports/ or apps/pipeline/references/', () => {
    const offenders = trackedFiles(['apps/pipeline/reports/**', 'apps/pipeline/references/**']);
    expect(offenders).toEqual([]);
  });

  it('no tracked file matches a reference-workbook filename pattern (*-reference.xlsx / *-reference.csv)', () => {
    const offenders = trackedFiles(['**/*-reference.xlsx', '**/*-reference.csv']);
    expect(offenders).toEqual([]);
  });
});
