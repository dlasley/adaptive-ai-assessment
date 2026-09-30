/**
 * Unit tests for `guardTrackedTreeWrite`, the shared write guard `eval-compare` and
 * `eval-review-export` each call once, on their own resolved output path, before their first write.
 * `git ls-files`-based governance tests (see `tests/eval-private-data-boundary.test.ts`) can only
 * ever see what already landed in a commit; these prove the runtime refusal itself, before any
 * write happens.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVAL_REPORTS_DIR, guardTrackedTreeWrite } from '../src/lib/eval/paths';
import { REPO_ROOT } from '../src/lib/paths';

function withCwd<T>(dir: string, fn: () => T): T {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

describe('guardTrackedTreeWrite', () => {
  describe('as eval-compare calls it (options.out ?? join(EVAL_REPORTS_DIR, ...))', () => {
    it('refuses an absolute path resolving inside the tracked apps/pipeline package', () => {
      const insideTracked = path.join(REPO_ROOT, 'apps', 'pipeline', 'reports', 'eval-compare-123.md');
      expect(() => guardTrackedTreeWrite(insideTracked)).toThrow(/Refusing to write/);
    });

    it('allows the EVAL_REPORTS_DIR default, which resolves under .private/eval', () => {
      const defaultOut = path.join(EVAL_REPORTS_DIR, 'eval-compare-123.md');
      expect(guardTrackedTreeWrite(defaultOut)).toBe(defaultOut);
    });
  });

  describe('as eval-review-export calls it (options.out, required — no fallback)', () => {
    it('refuses a relative --out that resolves inside apps/pipeline against the current directory', () => {
      withCwd(path.join(REPO_ROOT, 'apps', 'pipeline'), () => {
        expect(() => guardTrackedTreeWrite('reference/reviewer.xlsx')).toThrow(/Refusing to write/);
      });
    });

    it('allows an absolute path under .private/eval/references', () => {
      const referencePath = path.join(REPO_ROOT, '.private', 'eval', 'references', 'reviewer.xlsx');
      expect(guardTrackedTreeWrite(referencePath)).toBe(referencePath);
    });
  });

  it('resolves a relative path against process.cwd(), like any other CLI path flag', () => {
    const scratchDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-cwd-')));
    try {
      const resolved = withCwd(scratchDir, () => guardTrackedTreeWrite(path.join('out', 'report.md')));
      expect(resolved).toBe(path.join(scratchDir, 'out', 'report.md'));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('follows a symlinked ancestor to its real location before checking the boundary, catching a symlink outside the repo that points back inside the tracked tree', () => {
    const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-symlink-')));
    const linkPath = path.join(outsideDir, 'pipeline-link');
    fs.symlinkSync(path.join(REPO_ROOT, 'apps', 'pipeline'), linkPath);
    try {
      // The given path looks like it's entirely outside the repo (it starts under os.tmpdir()),
      // but the symlink resolves back inside apps/pipeline — the guard must catch that via realpath.
      expect(() => guardTrackedTreeWrite(path.join(linkPath, 'reports', 'out.md'))).toThrow(/Refusing to write/);
    } finally {
      // unlinkSync, not rmSync — this removes only the symlink itself, never the real
      // apps/pipeline directory it points at.
      fs.unlinkSync(linkPath);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows a path entirely outside REPO_ROOT (an operator directory, /tmp, another disk)', () => {
    const outside = path.join(os.tmpdir(), 'eval-output-example', 'report.md');
    const expected = path.join(fs.realpathSync(os.tmpdir()), 'eval-output-example', 'report.md');
    expect(guardTrackedTreeWrite(outside)).toBe(expected);
  });

  describe('.. traversal', () => {
    it('refuses a path that starts under .private/ but traverses back out into the tracked tree', () => {
      const escapesPrivate = path.join(REPO_ROOT, '.private', 'eval', '..', '..', 'apps', 'pipeline', 'reports', 'x.md');
      expect(() => guardTrackedTreeWrite(escapesPrivate)).toThrow(/Refusing to write/);
    });

    it('allows a path that starts inside the tracked tree but traverses into .private/', () => {
      const reachesPrivate = path.join(REPO_ROOT, 'apps', 'pipeline', '..', '..', '.private', 'eval', 'reports', 'x.md');
      expect(guardTrackedTreeWrite(reachesPrivate)).toBe(path.join(REPO_ROOT, '.private', 'eval', 'reports', 'x.md'));
    });

    it('allows a path that traverses above REPO_ROOT entirely', () => {
      const aboveRepoRoot = path.join(REPO_ROOT, '..', 'some-operator-dir', 'x.md');
      expect(guardTrackedTreeWrite(aboveRepoRoot)).toBe(path.join(path.dirname(REPO_ROOT), 'some-operator-dir', 'x.md'));
    });
  });

  it('refuses a case-varied ancestor that would otherwise land inside the tracked tree (macOS default case-insensitive filesystem)', () => {
    // On a case-insensitive filesystem, fs.existsSync/realpathSync resolve this to the real,
    // correctly-cased apps/pipeline directory (still inside the tracked tree, still refused). On a
    // case-sensitive filesystem, the mismatched segments never exist on disk, so they're carried
    // through as an unresolved tail — which still sits lexically under REPO_ROOT and is refused for
    // the same reason. Either way, a case-varied path must never be treated as outside the repo.
    const caseVaried = path.join(REPO_ROOT, 'Apps', 'Pipeline', 'reports', 'x.md');
    expect(() => guardTrackedTreeWrite(caseVaried)).toThrow(/Refusing to write/);
  });
});
