/**
 * Runs `main()` only when this module is the process entry point (`npx tsx <file>.ts`), not when
 * it's imported by something else — the dispatcher reading a command's exported `cli` for its
 * spec, or a test reading an exported constant. Every command in `src/commands/` calls this at
 * the bottom instead of invoking `main()` directly, so importing one to read its spec never also
 * runs it.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Both sides are resolved through symlinks: Node reports `import.meta.url` as the real path while
// `process.argv[1]` keeps the path the user typed.
function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

export function runIfMain(moduleUrl: string, main: () => Promise<void>): void {
  const entry = process.argv[1] ? realPathOrNull(process.argv[1]) : null;
  if (!entry || entry !== realPathOrNull(fileURLToPath(moduleUrl))) return;
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
