/**
 * Source-level regression check that every eval command writing to disk calls
 * `guardTrackedTreeWrite` before its first `writeFileSync`/`mkdirSync`, one command file at a time.
 *
 * `eval-paths.test.ts` proves the helper itself refuses the right paths; `eval-review-export`'s guard
 * call runs before any DB access, so a real, DB-free subprocess run proves it's actually wired in
 * (see `eval-review-export-write-guard.test.ts`). `eval-compare`'s guard call sits after several
 * `await store.*` calls (baseline/candidate run and item lookups), so reaching it without a real or
 * fully-mocked Supabase store isn't possible in a DB-free test — this file is the regression net for
 * that command instead: it fails if a future edit removes the guard call, or adds a new write call
 * ahead of it, without needing a live database.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS_DIR } from '../src/lib/paths';

/** Extracts `main()`'s own body text — the actual call-order that runs at execution time — rather
 * than raw file line numbers, which would misorder a write inside a helper function declared above
 * its call site (`eval-review-export.ts`'s `runTranscriptionReferenceExport`, defined before `main()` but
 * called from partway through it). */
function extractMainBody(source: string): string {
  // 'async function main(' (no closing paren) matches both a bare `main()` and a testability seam
  // like `main(deps: {...} = {})` — the parameter list isn't what this check cares about.
  const start = source.indexOf('async function main(');
  const end = source.indexOf('runIfMain(import.meta.url, main)');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("couldn't locate main()'s body between 'async function main(' and the runIfMain() call");
  }
  return source.slice(start, end);
}

/** Per-command list of calls within `main()`'s body that ultimately write to disk — either
 * directly (`writeFileSync`/`mkdirSync`) or by calling a helper known to write
 * (`runTranscriptionReferenceExport`, which takes the guard's already-checked output path as an arg). */
const WRITE_TRIGGERING_CALLS: Record<string, string[]> = {
  'eval-compare': ['writeFileSync('],
  // mkdirSync isn't called directly inside main() — only inside runTranscriptionReferenceExport, which
  // main() calls with the guard's already-checked path, so that call stands in for it here.
  'eval-review-export': ['writeFileSync(', 'runTranscriptionReferenceExport('],
};

describe('every write-capable eval command calls guardTrackedTreeWrite before it writes', () => {
  it.each(Object.keys(WRITE_TRIGGERING_CALLS))('%s.ts: every write-triggering call inside main() comes after the guard call', (name) => {
    const source = fs.readFileSync(path.join(COMMANDS_DIR, `${name}.ts`), 'utf-8');
    const mainBody = extractMainBody(source);

    const guardIndex = mainBody.indexOf('guardTrackedTreeWrite(');
    expect(guardIndex, `expected main() in ${name}.ts to call guardTrackedTreeWrite`).toBeGreaterThan(-1);

    for (const call of WRITE_TRIGGERING_CALLS[name]) {
      let searchFrom = 0;
      let found = 0;
      for (;;) {
        const index = mainBody.indexOf(call, searchFrom);
        if (index === -1) break;
        found++;
        expect(index, `expected ${name}.ts's main() call to ${call} at offset ${index} to come after guardTrackedTreeWrite at offset ${guardIndex}`).toBeGreaterThan(guardIndex);
        searchFrom = index + call.length;
      }
      expect(found, `expected main() in ${name}.ts to call ${call} at least once`).toBeGreaterThan(0);
    }
  });

  it('no other command file under src/commands/ writes to disk without this list knowing about it', () => {
    const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));
    const writers = files.filter((f) => {
      const source = fs.readFileSync(path.join(COMMANDS_DIR, f), 'utf-8');
      return /\b(writeFileSync|mkdirSync)\(/.test(source);
    });

    // Non-eval writers are pre-existing and out of scope for this file's regression net; only
    // assert that the eval writers are exactly the two already covered above, so a newly-added
    // eval command that writes to disk doesn't silently skip the guard.
    const evalWriters = writers.filter((f) => f.startsWith('eval-'));
    expect(evalWriters.sort()).toEqual(['eval-compare.ts', 'eval-review-export.ts']);
  });
});
