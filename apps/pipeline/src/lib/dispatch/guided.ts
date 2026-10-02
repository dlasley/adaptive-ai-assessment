/**
 * Interactive guided mode: picks a command or a named workflow, walks the command's flag spec
 * (choices as select lists, booleans as confirm, numbers validated, required fields enforced),
 * previews the resolved Supabase target for a write-capable command, shows the equivalent direct
 * command, and asks to confirm before running it. Every prompt-driving decision (which flags to
 * ask about, how an answer maps to argv) lives in `guided-argv.ts` so it's testable without a TTY;
 * this file is the thin interactive shell around it.
 */

import { confirm, number, input, select } from '@inquirer/prompts';
import { groupByArea } from './discovery';
import { spawnCommand } from './spawn-command';
import { answersToArgv, formatCommandLine, type GuidedAnswers } from './guided-argv';
import { listWorkflows, runWorkflow } from './workflows';
import { previewSupabaseTarget, printUnconfirmedTargetHelp } from './supabase-target-preview';
import type { CommandMeta } from './types';
import type { OptionSpecs } from '../options/types';

const GUIDED_WORKFLOWS_CHOICE = '__workflows__';

// `FlagSpec['default']` is typed `string | number | boolean | undefined` regardless of `type`
// (see `lib/options/types.ts`) — these casts recover what `spec.type` already established at
// runtime, in each branch below.

async function promptForFlag(spec: OptionSpecs[string]): Promise<string | number | boolean | undefined> {
  const message = spec.required ? `${spec.help} (required)` : `${spec.help} (optional — leave blank to skip)`;

  if (spec.type === 'boolean') {
    return confirm({ message: spec.help, default: (spec.default as boolean | undefined) ?? false });
  }

  if (spec.type === 'number') {
    const value = await number({
      message,
      default: spec.default as number | undefined,
      required: spec.required,
      validate: (v) => (spec.min !== undefined && v !== undefined && v < spec.min ? `Must be at least ${spec.min}` : true),
    });
    return value ?? undefined;
  }

  if (spec.choices && spec.choices.length > 0) {
    if (!spec.required) {
      const choice = await select({
        message,
        choices: [{ name: '(skip)', value: '' }, ...spec.choices.map((c) => ({ name: c, value: c }))],
        default: (spec.default as string | undefined) ?? '',
      });
      return choice === '' ? undefined : choice;
    }
    return select({
      message,
      choices: spec.choices.map((c) => ({ name: c, value: c })),
      default: spec.default as string | undefined,
    });
  }

  const value = await input({
    message,
    default: spec.default as string | undefined,
    validate: (v) => (spec.required && !v ? 'Required' : true),
  });
  return value === '' ? undefined : value;
}

/** Walks every non-internal flag in `specs`, returning the collected answers. `yes-production`
 * is skipped — guided mode handles the production-target confirmation itself (see
 * `previewSupabaseTarget`), not as a flag the user answers directly. */
async function walkSpecs(specs: OptionSpecs): Promise<GuidedAnswers> {
  const answers: GuidedAnswers = {};
  for (const [flagName, spec] of Object.entries(specs)) {
    if (flagName === 'yes-production') continue;
    answers[flagName] = await promptForFlag(spec);
  }
  return answers;
}

async function runGuidedCommand(command: CommandMeta, commandsDir: string): Promise<void> {
  if (!command.specs) {
    console.log(`${command.name} doesn't declare a flag spec (bespoke script) — run it directly:`);
    console.log(`  npx tsx apps/pipeline/src/commands/${command.name}.ts <markdown-file> <unit-id>`);
    console.log(`  npx tsx apps/pipeline/src/commands/${command.name}.ts --consolidate`);
    return;
  }

  const answers = await walkSpecs(command.specs);
  const args = answersToArgv(command.specs, answers);

  const isWriteCapable = 'write-db' in command.specs;
  if (isWriteCapable && answers['write-db'] === true && !previewSupabaseTarget()) {
    printUnconfirmedTargetHelp();
    return;
  }

  console.log('');
  console.log(formatCommandLine(command.name, args));
  const proceed = await confirm({ message: 'Run this command?', default: true });
  if (!proceed) {
    console.log('Cancelled.');
    return;
  }

  const result = await spawnCommand(command.name, args, { commandsDir });
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
  }
}

export async function runGuidedMode(commands: CommandMeta[], commandsDir: string): Promise<void> {
  const workflows = listWorkflows();
  const groups = groupByArea(commands);

  const choices = [
    ...(workflows.length > 0 ? [{ name: 'Guided workflows (multi-step)', value: GUIDED_WORKFLOWS_CHOICE }] : []),
    ...groups.flatMap((group) => [
      ...group.commands.map((c) => ({ name: `${c.name} — ${c.description}`, value: c.name })),
    ]),
  ];

  const picked = await select({ message: 'What do you want to do?', choices, pageSize: 20 });

  if (picked === GUIDED_WORKFLOWS_CHOICE) {
    const workflowId = await select({
      message: 'Which workflow?',
      choices: workflows.map((w) => ({ name: `${w.name} — ${w.description}`, value: w.id })),
    });
    await runWorkflow(workflowId, commandsDir);
    return;
  }

  const command = commands.find((c) => c.name === picked);
  if (!command) return;
  await runGuidedCommand(command, commandsDir);
}
