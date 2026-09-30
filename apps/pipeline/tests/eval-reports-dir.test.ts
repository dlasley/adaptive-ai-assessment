/**
 * `EVAL_REPORTS_DIR` is computed once, at module load, from `process.env.EVAL_REPORTS_DIR ??
 * path.join(REPO_ROOT, '.private', 'eval', 'reports')`. `eval-paths.test.ts` uses the default value
 * indirectly (building a path under it); this file asserts the default's own resolution directly —
 * that it's anchored on `REPO_ROOT`, not `process.cwd()` — and that the `EVAL_REPORTS_DIR`
 * environment variable overrides it. Each test reloads the module fresh (`vi.resetModules()` plus a
 * dynamic import) since the value is a module-level constant, computed once per import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from '../src/lib/paths';

describe('EVAL_REPORTS_DIR', () => {
  const originalCwd = process.cwd();
  const originalEnvValue = process.env.EVAL_REPORTS_DIR;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnvValue === undefined) delete process.env.EVAL_REPORTS_DIR;
    else process.env.EVAL_REPORTS_DIR = originalEnvValue;
  });

  it('defaults to .private/eval/reports under REPO_ROOT, independent of process.cwd()', async () => {
    delete process.env.EVAL_REPORTS_DIR;
    const scratchDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eval-reports-dir-cwd-')));
    process.chdir(scratchDir);

    try {
      const { EVAL_REPORTS_DIR } = await import('../src/lib/eval/paths');
      expect(EVAL_REPORTS_DIR).toBe(path.join(REPO_ROOT, '.private', 'eval', 'reports'));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('is overridden by the EVAL_REPORTS_DIR environment variable', async () => {
    const override = path.join(os.tmpdir(), 'eval-reports-dir-override-example');
    process.env.EVAL_REPORTS_DIR = override;

    const { EVAL_REPORTS_DIR } = await import('../src/lib/eval/paths');
    expect(EVAL_REPORTS_DIR).toBe(override);
  });
});
