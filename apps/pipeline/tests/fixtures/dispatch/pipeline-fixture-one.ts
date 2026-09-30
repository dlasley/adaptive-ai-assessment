/**
 * Fixture command for discovery tests — import-safe, like every real command in src/commands/.
 */
import { defineCli } from '../../../src/lib/options/define-cli';
import { loggingFlags } from '../../../src/lib/options/groups';
import { runIfMain } from '../../../src/lib/run-if-main';

export const cli = defineCli(
  {
    unit: { type: 'string', positional: true, help: 'Target unit' },
    count: { type: 'number', default: 5, min: 1, help: 'How many' },
    difficulty: {
      type: 'string',
      choices: ['beginner', 'intermediate', 'advanced'] as const,
      help: 'Difficulty level',
    },
    ...loggingFlags,
  },
  {
    name: 'pipeline-fixture-one',
    description: 'A fixture command for discovery tests.',
  },
);

async function main(): Promise<void> {
  cli.parse();
}

runIfMain(import.meta.url, main);
