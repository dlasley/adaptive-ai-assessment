/**
 * Small filesystem helpers shared by commands that write output files to user-supplied paths
 * (`--output`, `--report`) — most commonly under `content/exports/`, which is gitignored and
 * absent on a fresh clone.
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';

/** Creates the parent directory of `filePath` if it doesn't already exist. */
export function ensureDirFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
