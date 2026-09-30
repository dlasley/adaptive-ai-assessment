/**
 * Spawns a pipeline command with the same argv, stdio, and exit code semantics as running it
 * directly with `npx tsx <script> [args]` — including the `--yes-production` check in
 * `lib/supabase-target.ts`, which reads `process.argv` on the child process, not anything the
 * dispatcher parses and re-serializes.
 *
 * Resolves `tsx`'s own CLI entry point and spawns it directly with `node` instead of shelling out
 * through `npx tsx` (the pattern `lib/script-runner.ts` uses for the same purpose): passing an
 * argv array to a real executable needs no shell, so there's nothing for a value containing shell
 * metacharacters to break out of, and Node doesn't emit its `shell: true` args-not-escaped
 * deprecation warning on every command run.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

export interface SpawnCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function resolveTsxCli(): string {
  const tsxPackageJson = require.resolve('tsx/package.json');
  const tsxPackage = require(tsxPackageJson) as { bin: string };
  return path.join(path.dirname(tsxPackageJson), tsxPackage.bin);
}

export function spawnCommand(name: string, args: string[], opts: { commandsDir: string }): Promise<SpawnCommandResult> {
  const scriptPath = path.join(opts.commandsDir, `${name}.ts`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [resolveTsxCli(), scriptPath, ...args], { stdio: 'inherit' });

    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });

    child.on('error', (err) => {
      console.error(`Failed to run ${name}: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
  });
}

/** Forwards a spawned command's outcome to the current process: re-sends its signal, or exits
 * with its code. Used only by the top-level dispatcher — workflow steps use the raw result to
 * decide whether to continue instead of exiting the whole dispatcher process. */
export function forwardResultAndExit(result: SpawnCommandResult): never {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    // process.kill with a terminating signal doesn't return control; this satisfies the `never`
    // return type for signals that don't terminate (which shouldn't reach here in practice).
    throw new Error(`Unreachable: signal ${result.signal} did not terminate the process`);
  }
  process.exit(result.code ?? 1);
}
