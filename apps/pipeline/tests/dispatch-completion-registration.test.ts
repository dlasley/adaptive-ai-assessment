/**
 * Runs the actual generated completion scripts in a real shell and checks that `pipeline`
 * registers as a completion target — a string-match test on the generated text (see
 * dispatch-completion.test.ts) would have passed with the old, broken zsh generator too, since
 * `#compdef pipeline` and an unconditional `_pipeline "$@"` call are both present in the text; the
 * bug was that `#compdef` only takes effect on fpath autoload, and the documented
 * `source <(pipeline completion zsh)` install runs the file as a plain script body instead. This
 * is exactly the class of failure the code review that added this test caught by sourcing the
 * script in a real `zsh -f` session rather than only reading the generator's output.
 *
 * Skipped (not failed) when zsh or bash isn't on PATH — both ship on macOS and most Linux CI
 * images; where it's missing, `apt-get install zsh` (Ubuntu) covers it.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateZshCompletion } from '../src/lib/dispatch/completion-zsh';
import { generateBashCompletion } from '../src/lib/dispatch/completion-bash';
import { discoverCommands } from '../src/lib/dispatch/discovery';
import { unitIdsFromPdfDir } from '../src/lib/dispatch/completion-units';
import { COMMANDS_DIR, PDF_DIR } from '../src/lib/paths';

function isAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const zshAvailable = isAvailable('zsh');
const bashAvailable = isAvailable('bash');

const commands = await discoverCommands(COMMANDS_DIR);
const units = unitIdsFromPdfDir(PDF_DIR);

describe.skipIf(!zshAvailable)('zsh completion — real shell registration', () => {
  it('registers pipeline as a completion target when sourced (the documented install command)', () => {
    const script = generateZshCompletion(commands, { units });

    // -f: no user rc files, so this only depends on the script itself. compinit -D avoids the
    // (slow, environment-dependent) security-check prompt for autoloaded functions.
    const output = execFileSync(
      'zsh',
      [
        '-f',
        '-c',
        `autoload -U compinit && compinit -D
source /dev/stdin <<'PIPELINE_COMPLETION_EOF'
${script}
PIPELINE_COMPLETION_EOF
[[ \${+_comps[pipeline]} == 1 ]] && echo REGISTERED || echo NOT-REGISTERED`,
      ],
      { encoding: 'utf-8' },
    );

    expect(output).toContain('REGISTERED');
    expect(output).not.toContain('NOT-REGISTERED');
  });

  it('does not error when sourced', () => {
    const script = generateZshCompletion(commands, { units });

    expect(() =>
      execFileSync(
        'zsh',
        [
          '-f',
          '-c',
          `autoload -U compinit && compinit -D
source /dev/stdin <<'PIPELINE_COMPLETION_EOF'
${script}
PIPELINE_COMPLETION_EOF`,
        ],
        { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'pipe'] },
      ),
    ).not.toThrow();
  });

  it('registers pipeline as a completion target from fpath autoload (install option (b): a file named _pipeline on fpath, discovered by compinit at shell start)', () => {
    const script = generateZshCompletion(commands, { units });
    const fpathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-fpath-test-'));
    try {
      fs.writeFileSync(path.join(fpathDir, '_pipeline'), script);

      // -u: skip the "insecure directory" ownership/permission prompt compinit would otherwise
      // want an interactive terminal for — irrelevant here, this is our own freshly created dir.
      const output = execFileSync(
        'zsh',
        [
          '-f',
          '-c',
          `fpath=(${fpathDir} $fpath)
autoload -U compinit && compinit -u -D
[[ \${+_comps[pipeline]} == 1 ]] && echo REGISTERED || echo NOT-REGISTERED`,
        ],
        { encoding: 'utf-8' },
      );

      expect(output).toContain('REGISTERED');
      expect(output).not.toContain('NOT-REGISTERED');
    } finally {
      fs.rmSync(fpathDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!bashAvailable)('bash completion — real shell registration', () => {
  it('registers pipeline as a completion target when sourced', () => {
    const script = generateBashCompletion(commands, { units });

    const output = execFileSync(
      'bash',
      [
        '--norc',
        '--noprofile',
        '-c',
        `source /dev/stdin <<'PIPELINE_COMPLETION_EOF'
${script}
PIPELINE_COMPLETION_EOF
complete -p pipeline`,
      ],
      { encoding: 'utf-8' },
    );

    expect(output).toContain('complete');
    expect(output).toContain('_pipeline_complete');
    expect(output).toContain('pipeline');
  });
});
