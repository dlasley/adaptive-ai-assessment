/**
 * Shared process execution helpers.
 *
 * Extracted from regenerate.ts — provides synchronous and async
 * script execution, plus interactive prompt utility.
 */

import { execSync, spawn } from 'child_process';
import readline from 'readline';

export interface StepResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Run a script synchronously and capture output
 */
export function runScript(command: string, args: string[], dryRun: boolean): StepResult {
  const fullCommand = `npx tsx ${command} ${args.join(' ')}`;

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
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', command, ...args], {
      stdio: 'inherit',
      shell: true,
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0 });
    });

    proc.on('error', (err) => {
      console.error(`  ❌ Error: ${err.message}`);
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
