/**
 * A second fixture command, in a different area, for discovery/grouping tests — import-safe, like
 * every real command in src/commands/.
 */
import { defineCli } from '../../../src/lib/options/define-cli';
import { dbTargetFlags } from '../../../src/lib/options/groups';
import { runIfMain } from '../../../src/lib/run-if-main';

export const cli = defineCli(
  {
    ...dbTargetFlags,
    limit: { type: 'number', help: 'Row limit' },
  },
  {
    name: 'db-fixture-two',
    description: 'A second fixture command for discovery tests.',
  },
);

async function main(): Promise<void> {
  cli.parse();
}

runIfMain(import.meta.url, main);
