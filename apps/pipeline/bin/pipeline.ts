#!/usr/bin/env -S npx tsx
/**
 * `pipeline` — dispatcher for apps/pipeline's content pipeline commands.
 *
 * `pipeline <command> [options]` runs `src/commands/<command>.ts` with the same argv, stdio, and
 * exit code as `npx tsx apps/pipeline/src/commands/<command>.ts [options]` (see
 * `lib/dispatch/spawn-command.ts`). This is the package.json `bin` target: npm workspaces symlink
 * it so `npx --no -- pipeline` works from the repo root, and `npm link` (or adding the repo root's
 * `node_modules/.bin` to PATH) makes a bare `pipeline` work too.
 *
 * `pipeline` with no arguments, at an interactive TTY and outside CI, enters guided mode instead
 * of printing help (see `lib/dispatch/tty-gate.ts` for the exact conditions).
 */

import { COMMANDS_DIR, PDF_DIR } from '../src/lib/paths';
import { discoverCommands } from '../src/lib/dispatch/discovery';
import { formatHelp } from '../src/lib/dispatch/help';
import { nearestCommand } from '../src/lib/dispatch/nearest-command';
import { spawnCommand, forwardResultAndExit } from '../src/lib/dispatch/spawn-command';
import { shouldEnterGuidedMode } from '../src/lib/dispatch/tty-gate';
import { generateZshCompletion } from '../src/lib/dispatch/completion-zsh';
import { generateBashCompletion } from '../src/lib/dispatch/completion-bash';
import { unitIdsFromPdfDir } from '../src/lib/dispatch/completion-units';
import { runGuidedMode } from '../src/lib/dispatch/guided';

function completionInstructions(): string {
  return `pipeline completion: shell tab completion

Two ways to install, pick one:

(a) Always current, ~200ms per new shell. Add this line to ~/.zshrc, AFTER the line that calls
    \`compinit\` (usually near the top of ~/.zshrc, via \`autoload -U compinit && compinit\`):

      source <(pipeline completion zsh)

    Then reload: exec zsh. This regenerates completions (command names, flags, choice values, and
    \`--unit\` candidates from apps/pipeline/content/pdf/) every time a new shell starts, so
    they never go stale as commands or PDFs are added, at the cost of importing every command
    module on every shell start.

(b) Faster shell start, manual refresh. Write the script once to a file on fpath, BEFORE the
    \`compinit\` line in ~/.zshrc (autoload needs the file in place first):

      mkdir -p ~/.zfunc
      pipeline completion zsh > ~/.zfunc/_pipeline

    Add to ~/.zshrc, before \`compinit\`:

      fpath=(~/.zfunc $fpath)
      autoload -U compinit && compinit

    Re-run the \`pipeline completion zsh > ~/.zfunc/_pipeline\` line after adding a command, adding
    a PDF, or pulling changes. This mode doesn't regenerate itself.

Bash only supports (a). Add this to ~/.bashrc instead:

  source <(pipeline completion bash)

Either mode requires \`pipeline\` on PATH. \`npx --no -- pipeline\` always works without any setup, from the
repo root. For a bare \`pipeline\`: run \`npm link\` inside apps/pipeline/, or add the repo root's
node_modules/.bin (where npm workspaces place it) to PATH.

Print a completion script directly:

  pipeline completion zsh
  pipeline completion bash`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;

  if (first === 'completion') {
    const shell = rest[0];
    if (shell === 'zsh' || shell === 'bash') {
      const commands = await discoverCommands(COMMANDS_DIR);
      const units = unitIdsFromPdfDir(PDF_DIR);
      console.log(shell === 'zsh' ? generateZshCompletion(commands, { units }) : generateBashCompletion(commands, { units }));
      return;
    }
    console.log(completionInstructions());
    return;
  }

  const commands = await discoverCommands(COMMANDS_DIR);

  if (argv.length === 0) {
    const guided = shouldEnterGuidedMode({
      argv,
      isStdinTTY: process.stdin.isTTY === true,
      isStdoutTTY: process.stdout.isTTY === true,
      isCI: !!process.env.CI,
    });
    if (guided) {
      await runGuidedMode(commands, COMMANDS_DIR);
      return;
    }
    console.log(formatHelp(commands));
    return;
  }

  if (first === '--help' || first === '-h') {
    console.log(formatHelp(commands));
    return;
  }

  const match = commands.find((c) => c.name === first);
  if (!match) {
    const suggestion = nearestCommand(first, commands.map((c) => c.name));
    console.error(`Unknown command: '${first}'${suggestion ? `. Did you mean '${suggestion}'?` : ''}`);
    console.error('Run `pipeline --help` (or `pipeline` at a TTY) to see all commands.');
    process.exit(1);
  }

  const result = await spawnCommand(first, rest, { commandsDir: COMMANDS_DIR });
  forwardResultAndExit(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
