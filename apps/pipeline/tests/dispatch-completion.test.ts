import { describe, expect, it } from 'vitest';
import { generateZshCompletion } from '../src/lib/dispatch/completion-zsh';
import { generateBashCompletion } from '../src/lib/dispatch/completion-bash';
import type { CommandMeta } from '../src/lib/dispatch/types';

const FIXTURE_COMMANDS: CommandMeta[] = [
  {
    name: 'pipeline-run',
    area: 'pipeline',
    description: "Run it all: PDF -> Markdown -> Topics -> Questions.",
    specs: {
      unit: { type: 'string', positional: true, help: 'Unit id' },
      all: { type: 'boolean', default: false, help: 'Process every known unit' },
      difficulty: {
        type: 'string',
        choices: ['beginner', 'intermediate', 'advanced'],
        help: 'Filter by difficulty',
      },
      'write-db': {
        type: 'boolean',
        default: false,
        deprecatedAliases: ['sync-db'],
        help: "Write it's results to the DB",
      },
    },
  },
  {
    name: 'db-check-connection',
    area: 'db',
    description: 'Verify Supabase connectivity and schema for the core tables.',
    // no specs — bespoke command
  },
];

const UNITS = ['introduction', 'unit-1', 'unit-2'];

describe('generateZshCompletion', () => {
  const script = generateZshCompletion(FIXTURE_COMMANDS, { units: UNITS });

  it('declares the #compdef directive for pipeline', () => {
    expect(script.startsWith('#compdef pipeline')).toBe(true);
  });

  it('registers via compdef when sourced directly, not only when autoloaded from fpath', () => {
    // #compdef only takes effect on autoload; `source <(pipeline completion zsh)` (the documented
    // install command) runs the file as a plain script body, so the script must also call
    // `compdef _pipeline pipeline` itself. See dispatch-completion-registration.test.ts for a real
    // `zsh -f` check that this actually registers, not just that the text is present.
    expect(script).toContain('compdef _pipeline pipeline');
  });

  it('lists every command name with an escaped colon-safe description', () => {
    expect(script).toContain("'pipeline-run:Run it all");
    expect(script).toContain("'db-check-connection:Verify Supabase connectivity and schema for the core tables.'");
  });

  it('completes a boolean flag with no value action', () => {
    expect(script).toContain('--all[Process every known unit]');
  });

  it('completes a choice flag with its fixed value list', () => {
    expect(script).toContain('--difficulty[Filter by difficulty]:value:(beginner intermediate advanced)');
  });

  it('completes --unit against the PDF-derived unit list variable, not the literal word "units"', () => {
    expect(script).toContain('--unit[Unit id]:unit:($units)');
    expect(script).toContain("units=('introduction' 'unit-1' 'unit-2')");
  });

  it('does not advertise a deprecated alias as a completable flag', () => {
    expect(script).not.toContain('--sync-db[');
  });

  it('escapes an embedded single quote in a flag help string', () => {
    expect(script).toContain("Write it'\\''s results to the DB");
  });

  it('falls back to --help-only completion for a bespoke command with no spec', () => {
    expect(script).toContain('db-check-connection)');
    expect(script).toContain("_arguments '--help[Show this help]'");
  });
});

describe('generateBashCompletion', () => {
  const script = generateBashCompletion(FIXTURE_COMMANDS, { units: UNITS });

  it('registers the completion function for pipeline', () => {
    expect(script).toContain('complete -F _pipeline_complete pipeline');
  });

  it('lists every command name in the top-level word list', () => {
    expect(script).toContain('pipeline-run');
    expect(script).toContain('db-check-connection');
  });

  it('falls back to --help-only completion for a bespoke command with no spec', () => {
    expect(script).toContain('db-check-connection)');
    expect(script).toContain('COMPREPLY=( $(compgen -W "--help" -- "$cur") )');
  });

  it('completes --unit against the units variable for a command with a unit flag', () => {
    expect(script).toContain('--unit) COMPREPLY=( $(compgen -W "$units" -- "$cur") ); return ;;');
    expect(script).toContain("local units='introduction unit-1 unit-2'");
  });

  it('completes a choice flag with its fixed value list', () => {
    expect(script).toContain('--difficulty) COMPREPLY=( $(compgen -W "beginner intermediate advanced" -- "$cur") ); return ;;');
  });
});
