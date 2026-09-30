/**
 * Discovery regression test against the real `src/commands` directory (not the `fixtures/dispatch`
 * directory `dispatch-discovery.test.ts` exercises). `bin/pipeline.ts` calls `discoverCommands`
 * once and reuses the same list for `--help`, direct dispatch, and guided mode's command picker —
 * so a single assertion against the real directory covers all three tasks named in the eval
 * framework's move: `pipeline eval-run --help`, `pipeline eval-run ...`, and guided mode's list.
 */

import { describe, expect, it } from 'vitest';
import { discoverCommands, groupByArea, listCommandFiles } from '../src/lib/dispatch/discovery';
import { COMMANDS_DIR } from '../src/lib/paths';

const EXPECTED_EVAL_COMMANDS = [
  'eval-compare',
  'eval-finding',
  'eval-rescore',
  'eval-review-export',
  'eval-review-import',
  'eval-run',
  'eval-seed-grading',
  'eval-set-create',
].sort();

describe('eval command discovery (real commands directory)', () => {
  it('lists all eval-* command files by name, without importing them', () => {
    const names = listCommandFiles(COMMANDS_DIR).filter((n) => n.startsWith('eval-'));
    expect(names.sort()).toEqual(EXPECTED_EVAL_COMMANDS);
  });

  it('discovers all eval-* commands with area "eval" and a readable spec/description', async () => {
    const commands = await discoverCommands(COMMANDS_DIR);
    const evalCommands = commands.filter((c) => c.name.startsWith('eval-'));

    expect(evalCommands.map((c) => c.name).sort()).toEqual(EXPECTED_EVAL_COMMANDS);
    for (const command of evalCommands) {
      expect(command.area).toBe('eval');
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it('groups the eval commands under the Evaluation area label — the same grouping guided mode renders its command list from', async () => {
    const commands = await discoverCommands(COMMANDS_DIR);
    const groups = groupByArea(commands);
    const evalGroup = groups.find((g) => g.area === 'eval');

    expect(evalGroup).toBeDefined();
    expect(evalGroup!.label).toBe('Evaluation');
    expect(evalGroup!.commands.map((c) => c.name).sort()).toEqual(EXPECTED_EVAL_COMMANDS);
  });
});
