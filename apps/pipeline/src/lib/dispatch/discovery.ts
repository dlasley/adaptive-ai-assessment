/**
 * Discovers `pipeline` commands by scanning `COMMANDS_DIR` for top-level `.ts` files matching
 * `<area>-<action>[-<object>].ts`, so the dispatcher's command list never drifts from what's
 * actually in the directory. `pipeline.ts` (no hyphen) and any other file that doesn't match the
 * pattern — dispatcher internals, non-command helpers — are excluded by construction.
 *
 * Each matching file is imported to read its real spec directly off the `cli` object
 * (`defineCli()`'s return value) instead of statically re-parsing the source text. This is safe
 * because every command in `src/commands/` calls `main()` through `runIfMain()`
 * (`lib/run-if-main.ts`), which only runs it when the file is the process entry point — importing
 * one here to read its `cli` never also runs it. A command with no `defineCli()` call (currently
 * only db-check-connection.ts) exports a `commandMeta` object instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AREAS, AREA_LABELS, type Area, type CommandMeta } from './types';
import type { Cli } from '../options/types';
import type { OptionSpecs } from '../options/types';

const COMMAND_FILE_PATTERN = new RegExp(`^(${AREAS.join('|')})-[a-z0-9-]+\\.ts$`);

interface CommandModule {
  cli?: Cli<OptionSpecs>;
  commandMeta?: { name: string; description: string };
}

function areaOf(name: string): Area {
  return name.slice(0, name.indexOf('-')) as Area;
}

/** Lists command names in `commandsDir` that match the naming convention, without importing them. */
export function listCommandFiles(commandsDir: string): string[] {
  return fs
    .readdirSync(commandsDir)
    .filter((file) => COMMAND_FILE_PATTERN.test(file))
    .map((file) => file.replace(/\.ts$/, ''))
    .sort();
}

async function loadCommandMeta(name: string, filePath: string): Promise<{ description: string; specs?: OptionSpecs }> {
  const mod = (await import(pathToFileURL(filePath).href)) as CommandModule;

  if (mod.cli) {
    return { description: mod.cli.config.description, specs: mod.cli.specs };
  }
  if (mod.commandMeta) {
    return { description: mod.commandMeta.description, specs: undefined };
  }
  throw new Error(
    `${name}.ts exports neither \`cli\` (defineCli()'s return value) nor \`commandMeta\` — the dispatcher can't read its spec.`,
  );
}

/** Discovers every command in `commandsDir` with its area and one-line description. */
export async function discoverCommands(commandsDir: string): Promise<CommandMeta[]> {
  const names = listCommandFiles(commandsDir);
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(commandsDir, `${name}.ts`);
      const { description, specs } = await loadCommandMeta(name, filePath);
      return { name, area: areaOf(name), description, specs };
    }),
  );
}

/** Groups commands by area, in the fixed display order (`AREAS`), dropping empty areas. */
export function groupByArea(commands: CommandMeta[]): Array<{ area: Area; label: string; commands: CommandMeta[] }> {
  return AREAS.map((area) => ({
    area,
    label: AREA_LABELS[area],
    commands: commands.filter((c) => c.area === area),
  })).filter((group) => group.commands.length > 0);
}
