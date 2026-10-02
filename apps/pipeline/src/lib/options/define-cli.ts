/**
 * Parses `process.argv` against a declarative `OptionSpecs` schema: validation, defaults, and
 * `--help` generation in one place instead of a hand-rolled `for`/`switch` loop per script.
 *
 * Flag-name recognition (unknown-flag detection) is done directly against argv
 * before handing known flags to `node:util`'s `parseArgs`, which does the actual tokenizing
 * (`--flag value`, `--flag=value`, boolean vs. string). That split keeps this module's own logic
 * limited to schema — defaults, choices, cross-field checks, help text — while the lexing (which
 * has genuine edge cases: quoting, `=`, multi-token values) stays in the standard library.
 */

import { parseArgs as nodeParseArgs } from 'node:util';
import type { Cli, CliConfig, OptionSpecs, ParsedOptions } from './types';

function toCamelCase(kebabName: string): string {
  return kebabName.replace(/-([a-z0-9])/g, (_match, c: string) => c.toUpperCase());
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function defineCli<S extends OptionSpecs>(specs: S, config: CliConfig<S>): Cli<S> {
  const canonicalNames = Object.keys(specs);

  // Resolves each positional flag to its 1-indexed slot (`true` is shorthand for slot 1), and
  // catches two flags claiming the same slot. Sorted by slot so help text and `parse()` alike can
  // walk positionals in argv order without re-deriving it.
  const positionalSlots = new Map<number, string>();
  for (const name of canonicalNames) {
    const positional = specs[name].positional;
    if (positional === undefined) continue;
    const slot = positional === true ? 1 : positional;
    const existing = positionalSlots.get(slot);
    if (existing) {
      throw new Error(
        `defineCli(${config.name}): both --${existing} and --${name} declare positional: ${slot}`,
      );
    }
    positionalSlots.set(slot, name);
  }
  const positionalsBySlot = [...positionalSlots.entries()].sort(([a], [b]) => a - b);

  function help(): string {
    const lines: string[] = [];
    if (config.banner) lines.push(config.banner);
    lines.push(config.description);
    lines.push('');
    const usagePositional = positionalsBySlot.map(([, name]) => ` <${name}>`).join('');
    lines.push(`Usage: npx tsx apps/pipeline/src/commands/${config.name}.ts${usagePositional} [options]`);
    lines.push('');
    lines.push('Value flags accept `--flag value` or `--flag=value`. Switches are written bare, with no value.');
    lines.push('');

    const groupOrder: string[] = [];
    const groupedEntries = new Map<string, string[]>();
    for (const name of canonicalNames) {
      const spec = specs[name];
      const group = spec.group ?? 'Options';
      if (!groupedEntries.has(group)) {
        groupedEntries.set(group, []);
        groupOrder.push(group);
      }

      const flagLabel = spec.type === 'boolean' ? `--${name}` : `--${name} <value>`;
      const notes: string[] = [];
      if (spec.choices) notes.push(`(${spec.choices.join('|')})`);
      if (spec.required) notes.push('(required)');
      if (spec.default !== undefined) notes.push(`(default: ${JSON.stringify(spec.default)})`);
      const suffix = notes.length ? ` ${notes.join(' ')}` : '';
      groupedEntries.get(group)!.push(`  ${flagLabel.padEnd(28)} ${spec.help}${suffix}`);
    }

    for (const group of groupOrder) {
      lines.push(`${group}:`);
      lines.push(...groupedEntries.get(group)!);
      lines.push('');
    }

    lines.push('  --help, -h                    Show this help');

    if (config.examples?.length) {
      lines.push('');
      lines.push('Examples:');
      for (const example of config.examples) lines.push(`  ${example}`);
    }

    return lines.join('\n');
  }

  function parse(argv: string[] = process.argv.slice(2)): ParsedOptions<S> {
    if (config.helpOnEmptyArgv && argv.length === 0) {
      console.log(help());
      process.exit(0);
    }
    const nodeOptions: Record<string, { type: 'string' | 'boolean' }> = {};
    for (const name of canonicalNames) {
      nodeOptions[name] = { type: specs[name].type === 'boolean' ? 'boolean' : 'string' };
    }

    // Tokenizing first means a value that starts with a dash (`--tolerance "-5pp"`,
    // `--count -5`) is seen as that option's value, never as a flag of its own.
    let values: Record<string, unknown>;
    let positionals: string[];
    let optionNames: string[];
    try {
      const parsed = nodeParseArgs({
        args: argv,
        options: nodeOptions,
        allowPositionals: true,
        strict: false,
        tokens: true,
      });
      ({ values, positionals } = parsed);
      optionNames = parsed.tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : []));
    } catch (err) {
      fail((err as Error).message);
    }

    if (optionNames.includes('help') || optionNames.includes('h')) {
      console.log(help());
      process.exit(0);
    }

    for (const name of optionNames) {
      if (!canonicalNames.includes(name)) {
        fail(`Unknown option: --${name} (see --help for usage)`);
      }
    }

    const result: Record<string, unknown> = {};

    for (const name of canonicalNames) {
      const spec = specs[name];
      const field = toCamelCase(name);

      let raw: unknown = values[name];

      if (raw === undefined && spec.positional !== undefined) {
        const slot = spec.positional === true ? 1 : spec.positional;
        raw = positionals[slot - 1];
      }

      if (raw === undefined) {
        if (spec.required) {
          fail(`Error: --${name} is required (see --help for usage).`);
        }
        result[field] = spec.default;
        continue;
      }

      if (spec.type === 'boolean') {
        if (raw !== true) {
          fail(`--${name} is a switch and takes no value; pass it bare`);
        }
        result[field] = true;
        continue;
      }

      if (typeof raw !== 'string') {
        fail(`--${name} needs a value`);
      }

      if (spec.type === 'number') {
        const num = Number(raw);
        if (Number.isNaN(num)) {
          fail(`--${name} must be a valid number`);
        }
        if (spec.min !== undefined && num < spec.min) {
          fail(`--${name} must be at least ${spec.min}`);
        }
        result[field] = num;
        continue;
      }

      if (spec.choices && !spec.choices.includes(raw as string)) {
        fail(`--${name} must be one of: ${spec.choices.join(', ')}`);
      }
      result[field] = raw;
    }

    const parsed = result as ParsedOptions<S>;

    if (config.validate) {
      const validationError = config.validate(parsed);
      if (validationError) fail(validationError);
    }

    return parsed;
  }

  return { parse, help, specs, config };
}
