/**
 * Shared git state utilities for pipeline scripts.
 *
 * Provides git info capture and safety checks for experiment mode.
 * Used by generate-questions.ts, audit-quality-mistral.ts, create-experiment.ts.
 */

import { execSync } from 'child_process';

export interface GitInfo {
  branch: string;
  commit: string;
  clean: boolean;
}

/**
 * Capture current git state without enforcing any rules.
 */
export function getGitInfo(): GitInfo {
  const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  return { branch, commit, clean: status.length === 0 };
}

/**
 * Check git state and enforce safety rules.
 *
 * - Experiments are blocked on the `main` branch (hard block).
 * - Dirty working trees emit a warning for experiments (informational only).
 * - Returns git info for provenance recording.
 */
export function checkGitState(opts: {
  experimentId?: string;
}): GitInfo {
  const git = getGitInfo();

  if (opts.experimentId && git.branch === 'main') {
    console.error('❌ Experiments must run on a branch, not main.');
    console.error('   Create a branch first: git checkout -b experiment/<name>');
    process.exit(1);
  }

  if (opts.experimentId && !git.clean) {
    console.warn('⚠️  Working tree has uncommitted changes — provenance may be imprecise.');
  }

  return git;
}
