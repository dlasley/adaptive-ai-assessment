/**
 * Directory anchors for the eval framework and the write guard every eval command calls before
 * writing to disk. `REPO_ROOT` is the pipeline's own export (`apps/pipeline/src/lib/paths.ts`) —
 * the eval framework lives inside the pipeline package, so it anchors on that rather than computing
 * its own. Callers needing the pipeline's prompts directory import `PROMPTS_DIR` from `../paths`
 * directly; this module doesn't re-export it.
 */

import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from '../paths';

/** Default location for eval-compare's markdown reports and eval-review-export's reviewer sheets —
 * outside the tracked tree, since both can carry course-specific question and answer text.
 * Overridable so an operator can point either command somewhere else entirely. */
export const EVAL_REPORTS_DIR = process.env.EVAL_REPORTS_DIR ?? path.join(REPO_ROOT, '.private', 'eval', 'reports');

/**
 * Resolves `inputPath` to its real, absolute location and throws before any write happens if that
 * location sits inside the tracked tree outside `.private/` — the one place eval output (reviewer
 * sheets, reference directories, comparison reports) is allowed to land within the repo. Every
 * write-capable eval command calls this once, on its own `--out`/output path, before its first
 * write.
 *
 * `inputPath` is resolved against `process.cwd()` like any other CLI path flag, so a relative
 * `--out` behaves the same whether or not it exists yet. The resolved path's nearest *existing*
 * ancestor is run through `fs.realpathSync()` before the not-yet-existing tail is rejoined onto it,
 * so a symlink anywhere in the already-created part of the path (a symlinked `apps/pipeline` or
 * `.private`, say) is followed to its real location rather than trusted at face value.
 */
export function guardTrackedTreeWrite(inputPath: string): string {
  const absolute = path.resolve(process.cwd(), inputPath);

  let existingAncestor = absolute;
  const tailSegments: string[] = [];
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    tailSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const realAncestor = fs.realpathSync(existingAncestor);
  const resolved = tailSegments.length > 0 ? path.join(realAncestor, ...tailSegments) : realAncestor;

  const privateDir = path.join(REPO_ROOT, '.private');
  const isOutsideRepo = path.relative(REPO_ROOT, resolved).startsWith('..');
  const isInsidePrivate = !path.relative(privateDir, resolved).startsWith('..');

  if (isOutsideRepo || isInsidePrivate) return resolved;

  throw new Error(
    `Refusing to write inside the tracked tree at ${resolved} — eval output must resolve outside ` +
      `${REPO_ROOT} or under ${privateDir}. Point --out (or EVAL_REPORTS_DIR) somewhere else.`,
  );
}
