/**
 * Derives `--unit` completion candidates from PDF filenames, mirroring the unit-id inference in
 * `pipeline-run.ts`'s `discoverUnitsFromFiles()`. Duplicated rather than imported: this file has
 * no dependencies beyond `node:fs`, and `pipeline completion zsh|bash` (which calls this on every
 * new shell, per the source-install option in `bin/pipeline.ts`'s completion instructions) would
 * otherwise pull in `pipeline-run.ts`'s full import graph (`db-queries`, `pipeline-steps`, ...) for
 * a few lines of filename parsing. `pipeline-run.ts` is import-safe like every other command (see
 * `lib/run-if-main.ts`) — the duplication here is a dependency-weight choice, not a safety one.
 */

import fs from 'node:fs';

export function unitIdsFromPdfDir(pdfDir: string): string[] {
  const ids = new Set<string>();
  if (!fs.existsSync(pdfDir)) return [];

  for (const file of fs.readdirSync(pdfDir)) {
    if (!file.toLowerCase().endsWith('.pdf')) continue;
    if (/introduction/i.test(file)) {
      ids.add('introduction');
      continue;
    }
    const match = file.match(/unit[_\s-]?(\d+)/i);
    if (match) ids.add(`unit-${match[1]}`);
  }

  return [...ids].sort((a, b) => {
    if (a === 'introduction') return -1;
    if (b === 'introduction') return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}
