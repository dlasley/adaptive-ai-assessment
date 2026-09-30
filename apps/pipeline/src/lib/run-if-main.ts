/**
 * Runs `main()` only when this module is the process entry point (`npx tsx <file>.ts`), not when
 * it's imported by something else — the dispatcher reading a command's exported `cli` for its
 * spec, or a test reading an exported constant. Every command in `src/commands/` calls this at
 * the bottom instead of invoking `main()` directly, so importing one to read its spec never also
 * runs it.
 */

import { pathToFileURL } from 'node:url';

export function runIfMain(moduleUrl: string, main: () => Promise<void>): void {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) return;
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
