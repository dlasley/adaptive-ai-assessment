/**
 * Shared process execution helpers.
 *
 * `command` is a pipeline command's filename relative to `COMMANDS_DIR`
 * (e.g. `content-suggest-topics.ts`), resolved to an absolute path here so
 * the spawned `npx tsx` invocation is independent of the caller's cwd —
 * these helpers work whether the parent script was itself run from the repo
 * root or from inside apps/pipeline.
 */

import { execSync, spawn } from 'child_process';
import path from 'path';
import readline from 'readline';
import { createLogger } from './logger';
import { COMMANDS_DIR } from './paths';

const logger = createLogger('script-runner');

export interface StepResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Run a script synchronously and capture output
 */
export function runScript(command: string, args: string[], dryRun: boolean): StepResult {
  const scriptPath = path.join(COMMANDS_DIR, command);
  const fullCommand = `npx tsx "${scriptPath}" ${args.join(' ')}`;

  if (dryRun) {
    console.log(`  [DRY RUN] Would execute: ${fullCommand}`);
    return { success: true, output: '[dry run - not executed]' };
  }

  try {
    const output = execSync(fullCommand, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || error.stderr,
    };
  }
}

/**
 * Run a script asynchronously with stdio inherited (streams output in real-time)
 */
export function runScriptAsync(
  command: string,
  args: string[]
): Promise<{ success: boolean }> {
  const scriptPath = path.join(COMMANDS_DIR, command);
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', scriptPath, ...args], {
      stdio: 'inherit',
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0 });
    });

    proc.on('error', (err) => {
      logger.error(`Error running ${command}`, { message: err.message });
      resolve({ success: false });
    });
  });
}

/**
 * Prompt user for confirmation (y/n)
 */
export async function promptUser(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}
