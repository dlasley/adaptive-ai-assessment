/**
 * Shared git state utility for pipeline scripts.
 *
 * Captures the current branch, commit, and working-tree cleanliness for provenance recording.
 * Used by questions-generate.ts.
 */

import { execSync } from 'child_process';

export interface GitInfo {
  branch: string;
  commit: string;
  clean: boolean;
}

/**
 * Capture current git state.
 */
export function getGitInfo(): GitInfo {
  const branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
  return { branch, commit, clean: status.length === 0 };
}
