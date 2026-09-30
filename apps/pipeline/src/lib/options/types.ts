/**
 * Declarative schema for the shared pipeline-script CLI parser (see `define-cli.ts`).
 *
 * A `FlagSpec` describes one flag: its type, default, validation, and help text. Scripts compose
 * specs from shared option groups (`groups.ts`) plus their own fields and hand the merged object
 * to `defineCli()`, which parses `process.argv` against the schema and returns a typed, validated
 * result.
 */

type FlagType = 'string' | 'number' | 'boolean';

type DefaultForType<T extends FlagType> = T extends 'boolean'
  ? boolean
  : T extends 'number'
    ? number
    : string;

interface FlagSpec<T extends FlagType = FlagType> {
  type: T;
  /** Only meaningful for `type: 'string'`. The parsed value must be one of these. */
  choices?: readonly string[];
  default?: DefaultForType<T>;
  required?: boolean;
  /** Only meaningful for `type: 'number'`. Values below this are a hard error. */
  min?: number;
  /**
   * Consumes a positional (non-flag) argv token instead of a `--flag`. `true` is shorthand for
   * position `1` — every single-positional command uses `true`. A number declares which 1-indexed
   * positional slot this flag reads, for a command that takes more than one in a fixed order. At
   * most one flag per spec object may claim a given position.
   */
  positional?: true | number;
  /** Alternate spellings treated identically to the canonical name — no warning. */
  aliases?: string[];
  /**
   * Alternate spellings accepted for backward compatibility. Using one prints a one-line stderr
   * warning naming the canonical flag, then behaves exactly like the canonical flag.
   */
  deprecatedAliases?: string[];
  /** One-line description, composed into the generated --help output. */
  help: string;
  /** Section heading in generated --help only; does not affect parsing. */
  group?: string;
}

export type OptionSpecs = Record<string, FlagSpec>;

type FieldType<S extends FlagSpec> = S['type'] extends 'boolean'
  ? boolean
  : S['type'] extends 'number'
    ? number
    : S['choices'] extends readonly (infer C)[]
      ? C
      : string;

/** True when a spec has an explicit `default`, so the parsed field is never `undefined`. */
type HasDefault<S extends FlagSpec> = undefined extends S['default'] ? false : true;

type IsRequired<S extends FlagSpec> = S['required'] extends true ? true : false;

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

/** kebab-case flag name -> camelCase field name, typed per FlagSpec['type']. */
export type ParsedOptions<S extends OptionSpecs> = {
  [K in keyof S as CamelCase<K & string>]: HasDefault<S[K]> extends true
    ? FieldType<S[K]>
    : IsRequired<S[K]> extends true
      ? FieldType<S[K]>
      : FieldType<S[K]> | undefined;
};

export interface CliConfig<S extends OptionSpecs> {
  name: string;
  description: string;
  examples?: string[];
  /**
   * Optional ASCII banner printed above the generated flag table — preserves the box-drawing
   * headers some scripts already print, rather than forcing every script into identical plain
   * help output.
   */
  banner?: string;
  /**
   * Cross-field checks a per-flag spec can't express (e.g. "--audit requires --write-db").
   * Return a string to fail with that message (exit 1); return void/undefined to pass.
   */
  validate?: (options: ParsedOptions<S>) => string | void;
  /**
   * Default false. Unknown flags are a hard error (`Unknown option: --xyz`, exit 1) unless a
   * script explicitly opts out.
   */
  allowUnknown?: boolean;
  /**
   * Default false. When true, an empty argv also prints help and exits 0 — for a script like
   * `pipeline-run.ts` where running with zero arguments has never meant "run with defaults" the
   * way it does everywhere else.
   */
  helpOnEmptyArgv?: boolean;
}

export interface Cli<S extends OptionSpecs> {
  parse(argv?: string[]): ParsedOptions<S>;
  help(): string;
  /** The flag spec this command was defined with — what the dispatcher (completion, guided mode)
   * reads instead of statically re-parsing the source file. Read-only: nothing about the running
   * command should observe or depend on this being mutated. */
  readonly specs: S;
  /** This command's own defineCli() config (name, description, examples, ...) — same reasoning. */
  readonly config: Readonly<CliConfig<S>>;
}
