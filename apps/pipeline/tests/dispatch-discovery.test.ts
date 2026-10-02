import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCommands, groupByArea } from '../src/lib/dispatch/discovery';
import { formatHelp } from '../src/lib/dispatch/help';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/dispatch');

describe('discoverCommands', () => {
  it('discovers only files matching the <area>-<action> naming convention', async () => {
    const names = (await discoverCommands(FIXTURES_DIR)).map((c) => c.name).sort();
    expect(names).toEqual(['content-fixture-bespoke', 'db-fixture-two', 'pipeline-fixture-one']);
  });

  it('reads name, area, description, and specs off a real cli object (defineCli()-based command)', async () => {
    const commands = await discoverCommands(FIXTURES_DIR);
    const one = commands.find((c) => c.name === 'pipeline-fixture-one');
    expect(one).toBeDefined();
    expect(one!.area).toBe('pipeline');
    expect(one!.description).toBe('A fixture command for discovery tests.');
    expect(one!.specs).toBeDefined();
    expect(one!.specs!.unit).toMatchObject({ type: 'string', positional: true, help: 'Target unit' });
    expect(one!.specs!.count).toMatchObject({ type: 'number', default: 5, min: 1 });
    expect(one!.specs!.difficulty.choices).toEqual(['beginner', 'intermediate', 'advanced']);
  });

  it('reads a spread shared group (...loggingFlags) as the real groups.ts object, not a re-derivation', async () => {
    const commands = await discoverCommands(FIXTURES_DIR);
    const one = commands.find((c) => c.name === 'pipeline-fixture-one');
    expect(one!.specs!.verbose).toMatchObject({ type: 'boolean', default: false });
    expect(one!.specs!.quiet).toMatchObject({ type: 'boolean', default: false });
  });

  it('reads the dbTargetFlags spread on a second fixture, in a different area', async () => {
    const commands = await discoverCommands(FIXTURES_DIR);
    const two = commands.find((c) => c.name === 'db-fixture-two');
    expect(two!.area).toBe('db');
    expect(two!.specs!['write-db']).toMatchObject({ type: 'boolean', default: false });
    expect(two!.specs!.limit).toMatchObject({ type: 'number', help: 'Row limit' });
  });

  it('reads name/description off commandMeta for a command with no defineCli() call', async () => {
    const commands = await discoverCommands(FIXTURES_DIR);
    const bespoke = commands.find((c) => c.name === 'content-fixture-bespoke');
    expect(bespoke).toBeDefined();
    expect(bespoke!.specs).toBeUndefined();
    expect(bespoke!.description).toBe('Bespoke fixture command with no defineCli call.');
  });

  it('excludes a file that does not match the <area>-<action> naming convention', async () => {
    const names = (await discoverCommands(FIXTURES_DIR)).map((c) => c.name);
    expect(names).not.toContain('not-a-command');
  });

  it('never runs a discovered command\'s main() — importing it for its spec has no side effects', async () => {
    // If discovery ever imported one of these fixtures without runIfMain()'s guard working, the
    // fixture's own cli.parse() would run against this test process's real argv (vitest's own
    // flags) and fail loudly (unknown option / process.exit) — so simply resolving instead of
    // throwing/exiting is the assertion.
    const commands = await discoverCommands(FIXTURES_DIR);
    expect(commands.length).toBeGreaterThan(0);
  });
});

describe('groupByArea', () => {
  it('groups commands by area in the fixed AREAS display order, dropping empty areas', async () => {
    const commands = await discoverCommands(FIXTURES_DIR);
    const groups = groupByArea(commands);
    expect(groups.map((g) => g.area)).toEqual(['pipeline', 'content', 'db']);
    expect(groups.find((g) => g.area === 'pipeline')!.commands.map((c) => c.name)).toEqual(['pipeline-fixture-one']);
  });
});

describe('discoverCommands with a broken command module', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-'));
    fs.writeFileSync(
      path.join(tmp, 'db-working.ts'),
      "export const commandMeta = { name: 'db-working', description: 'Works.' };\n",
    );
    fs.writeFileSync(path.join(tmp, 'db-broken.ts'), "throw new Error('module exploded on import');\n");
    fs.writeFileSync(path.join(tmp, 'db-no-export.ts'), 'export const unrelated = 1;\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('still lists the commands that load, and reports the broken ones as a readable line', async () => {
    const commands = await discoverCommands(tmp);
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(['db-broken', 'db-no-export', 'db-working']);
    expect(byName['db-working'].description).toBe('Works.');
    expect(byName['db-broken'].description).toContain('Failed to load');
    expect(byName['db-broken'].description).toContain('module exploded on import');
    expect(byName['db-no-export'].description).toContain('Failed to load');
  });

  it('keeps the broken command in the help listing', async () => {
    const help = formatHelp(await discoverCommands(tmp));

    expect(help).toContain('db-working');
    expect(help).toMatch(/db-broken\s+Failed to load/);
  });
});
