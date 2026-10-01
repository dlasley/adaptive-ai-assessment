# apps/pipeline

For a task-oriented walkthrough (ingesting a new unit, re-running generation, auditing, learning
resources, troubleshooting) see
[`docs/cli-guide-content-ingestion-and-question-pipeline.md`](../../docs/cli-guide-content-ingestion-and-question-pipeline.md).
This README is the full command and flag reference.

## Quick Reference

Commands are organized by prefix:

| Prefix | Purpose |
|--------|---------|
| `pipeline-run` | Full orchestrator: PDF to Markdown to Topics to Questions to Audit |
| `content-` | Topic extraction and resource extraction from learning materials |
| `questions-` | Question generation, generation planning, and audit (`questions-audit`) |
| `db-` | Database utilities |
| `eval-` | Model evaluation: frozen item sets, reference review, variant runs, paired comparison |

All commands support `--help` / `-h`. Three equivalent ways to run one:

```bash
pipeline questions-generate --unit unit-2 --write-db          # bare `pipeline`, once it's on PATH
npx --no -- pipeline questions-generate --unit unit-2 --write-db      # npx, from the repo root — no PATH setup needed
npx tsx apps/pipeline/src/commands/questions-generate.ts --unit unit-2 --write-db  # the direct long form
```

The first two run through the `pipeline` dispatcher below; the third runs the script directly.
All three behave identically: same flags, same stdout/stderr, same exit code.

Always run the npx form from inside this repo, as `npx --no -- pipeline`. Outside the repo, a plain
`npx pipeline` falls back to downloading and running an unrelated public npm package named
`pipeline`; `--no` makes npx stop instead, and `--` keeps npx from reading the command's options as its own. To use bare `pipeline` from any folder, register it
once with `npm link` in `apps/pipeline`.

---

## The `pipeline` dispatcher

`pipeline` (`bin/pipeline.ts`, the package's npm `bin` entry, plus `src/lib/dispatch/`) is a thin
frontend over the commands in `src/commands/`. It doesn't reimplement anything about how a command
parses its own flags or talks to Supabase. It discovers commands, runs one as a child process
with the same argv and exit code as calling it directly, and adds three things no individual
command has on its own: a grouped command list, shell tab completion, and an interactive picker.

### Command discovery

The command list isn't hand-maintained. On every invocation, `pipeline` scans `src/commands/` for
top-level `.ts` files matching `<area>-<action>[-<object>].ts` (the five areas from the Quick
Reference table above) and imports each one to read its exported `cli` (the `defineCli()` result:
name, description and option specs). Importing is safe because every command runs its `main()` only
when executed directly (`runIfMain`), and loads no environment file at import. The two commands that
parse their own arguments (`content-suggest-topics.ts`, `db-check-connection.ts`) export a
`commandMeta` with their name and description instead. Add a new command file that
follows the naming convention and it appears in `pipeline --help`, completion, and guided mode with
no other changes.

### `pipeline` / `pipeline --help`

Lists every discovered command, grouped by area, each with its one-line description:

```
pipeline --help
```

### Unknown command

A typo gets a nearest-match suggestion (edit distance against every discovered command name)
instead of a bare parser error:

```
$ pipeline questons-generate
Unknown command: 'questons-generate' — did you mean 'questions-generate'?
```

### Shell tab completion

```bash
pipeline completion zsh    # print a zsh completion script
pipeline completion bash   # print a bash completion script
pipeline completion        # print install instructions (no script)
```

The generated script completes command names (with descriptions), each command's own flags (with
their help text), fixed value lists for choice flags (`--difficulty`, `--type`, `--writing-type`,
`--columns`, ...), and unit ids for `--unit`, derived from filenames in `content/pdf/` and read fresh
every time the completion script runs, so it reflects whatever's on disk without a network call.

**Setup**: two options, zsh supports both, bash only (a):

**(a) Always current, ~200ms per new shell.** Add this line to `~/.zshrc`, *after* the line that
calls `compinit` (usually `autoload -U compinit && compinit`, near the top of the file):

```zsh
source <(pipeline completion zsh)
```

Then reload: `exec zsh` (or open a new terminal tab). Sourcing a subshell command at shell startup
regenerates the completion function from whatever's on disk right now, so it's never stale. The cost
is importing every command module (~60-90ms, measured) on every new shell, comparable to
what `kubectl`/`gh`'s own `completion zsh` setup recommends. Bash: add
`source <(pipeline completion bash)` to `~/.bashrc` instead.

**(b) Faster shell start, manual refresh.** Write the script once to a file on `fpath`, *before*
the `compinit` line in `~/.zshrc` (autoload needs the file in place first):

```zsh
# ~/.zshrc, before compinit:
fpath=(~/.zfunc $fpath)
autoload -U compinit && compinit
```

```bash
mkdir -p ~/.zfunc
pipeline completion zsh > ~/.zfunc/_pipeline
```

Re-run the `pipeline completion zsh > ~/.zfunc/_pipeline` line after adding a command, adding a
PDF, or pulling changes. This mode doesn't regenerate itself, unlike (a). zsh's `compinit`
discovers `_pipeline` on `fpath` the same way it discovers any other completion function; the
generated script works identically whether it's `source`d directly (a) or autoloaded this way (b).

Either mode needs `pipeline` on PATH. `npx --no -- pipeline` always works from the repo root without any
setup. For a bare `pipeline`: run `npm link` inside `apps/pipeline/`, or add
`apps/pipeline/node_modules/.bin` (or the repo root's `node_modules/.bin`, where npm workspaces
also place it) to PATH.

### Guided mode

Running `pipeline` with no arguments, at an interactive terminal, outside CI, enters guided mode:
pick a command (grouped by area, same as `--help`) or a named workflow (below), then answer its
options one at a time: choices as select lists, booleans as yes/no, numbers validated against
their `min`, required fields enforced, optional ones skippable. A command that can write to the
database (any command with `--write-db`) shows the resolved Supabase target before asking to
confirm the write. Before running anything, guided mode prints the exact equivalent direct command
and asks to confirm.

Guided mode never changes how a command behaves when run directly. It's a way of constructing the
same argv the command's own `defineCli()` would accept, not a separate code path. Outside a TTY, in
CI, or with any argument given, `pipeline` never enters guided mode; it prints `--help` instead
(this is also why `pipeline < /dev/null` doesn't hang in CI).

### Guided workflows

Guided mode also offers named, multi-step workflows (declared in
`src/lib/dispatch/workflows.ts`; see that file to add one) for sequences that span several
commands. Each step prints the direct command it's about to run, asks to continue, and stops the
workflow on a non-zero exit code.

**Ingest a new unit** — convert PDF(s), extract and review topics + generate questions (via
`pipeline-run --review-topics --write-db`, so a brand-new unit's topics are auto-upserted into the
`units` table in the same process that extracted them, reusing that step rather than reimplementing
it here), then submit a Mistral Large 3 batch audit scoped to the batch this run just created
(`questions-audit --llm-batch --batch-id <id>`, the default `--auditor mistral`). Batch jobs can
take up to ~24h; the workflow prints the exact resume command (`pipeline questions-audit
--llm-batch-resume <job-id> --write-db`) once the job is looked up from `llm_batch_jobs`.

**Resume a batch audit** — lists jobs from `llm_batch_jobs` that haven't been applied yet
(`applied_at IS NULL`), and resumes the one you pick.

*(A re-audit-existing-questions workflow was considered and deferred: picking scope (unit/batch/
type) and sync-vs-batch mode isn't a thin wrapper over one existing command the way the two above
are, and deserves its own design pass rather than a guess bolted onto this one.)*

---

## Shared CLI Conventions

Every script's flags are declared through `apps/pipeline/src/lib/options/define-cli.ts`, a shared option parser. It gives every script in this directory the same baseline behavior instead of each one hand-rolling argument parsing:

- `--flag value` and `--flag=value` are both accepted.
- An unrecognized flag fails immediately with a usage hint, rather than being silently ignored.
- `--help` / `-h` prints full usage, generated from the same option schema the script runs against.

Two option groups (`apps/pipeline/src/lib/options/groups.ts`) are shared by most scripts and are not re-documented per script below:

**Database target** (any script that can write to Supabase):

| Flag | Description |
|------|-------------|
| `--write-db` | Write results to the database (uses the secret key, bypasses RLS) |
| `--yes-production` | Confirm a write-capable run against an unexpected Supabase target |

`--sync-db` and `--mark-db` are deprecated aliases for `--write-db`; using either prints a warning and behaves the same as `--write-db`. See "Supabase target guard" below for what `--yes-production` gates.

**Logging** (every script):

| Flag | Description |
|------|-------------|
| `--verbose` | Show debug-level tracing |
| `--quiet` | Only show warnings and errors |

Neither flag set leaves the default `info` level. `--verbose` wins if both are passed. These resolve to a level via `levelFromFlags()` in `apps/pipeline/src/lib/logger.ts`, which is separate from the server-side logger the Next.js app uses (`apps/web/src/lib/logger.ts`); the pipeline logger has no production/preview gating since pipeline commands never run in a deployed environment.

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      pipeline-run.ts                             │
│  (orchestrator, runs the full pipeline for a unit)                │
└──────────────────────────────┬──────────────────────────────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
  PDF files             Markdown files          Topic extraction
  (content/pdf/)        (content/markdown/)
       │                       │                       │
       └──────────┬────────────┘                       │
                  ▼                                    │
        content-suggest-topics.ts ◄────────────────────┘
        (extracts teachable topics)
                  │
                  ▼
        questions-generate.ts
        (creates questions via AI, Stage 1+2)
                  │
                  ▼
        questions-audit.ts
        (quality gate, Stage 3 — --auditor mistral|sonnet)
                  │
                  ▼
            Supabase DB
            (questions table)
```

---

## Command Reference

### pipeline-run.ts

Full pipeline orchestrator: PDF to Markdown to Topics to Questions to Audit.

```bash
npx tsx apps/pipeline/src/commands/pipeline-run.ts <unit-id> [options]
npx tsx apps/pipeline/src/commands/pipeline-run.ts --unit <unit-id> [options]
npx tsx apps/pipeline/src/commands/pipeline-run.ts --all [options]

Options:
  --unit <unit-id>          Unit to process (alternative to positional arg or --all)
  --all                     Process every known unit
  --audit                   Run quality audit after generation (requires --write-db)
  --auditor <m>             Audit model: 'mistral' (default) or 'sonnet'
  --skip-convert            Skip PDF conversion (use existing markdown)
  --force-convert           Force PDF reconversion even if markdown exists
  --skip-topics             Skip topic extraction (use existing topics from DB)
  --skip-resources          Skip learning resource extraction
  --review-topics           Interactive topic review (for domain experts)
  --convert-only            Stop after PDF conversion (skip topics, generation, audit)
  --batch-id <id>           Custom batch ID
  --markdown-file <path>    Use specified markdown file (bypasses PDF conversion)
  --exclusion-pass <model>  Model slug for the teaching-content classifier gating each slide before its transcription call (default: MODELS.slideContentClassifier in packages/shared; pass "off" to transcribe every slide)
  --dry-run                 Show what would be done without executing
```

Plus the shared Database target and Logging flags above.

### content-suggest-topics.ts

Extract teachable topics from markdown learning materials. Each topic's `headings`
(`units.topics[].headings`, typed `TopicHeadingRef[]` in `@adaptive/shared/types`) are validated
against the document's real `#`-headings before the script's output can be written to the `units`
table. A heading that doesn't match gets one corrective retry against the model, then fails the
whole run loudly rather than silently storing an unverifiable mapping.

Heading *text* alone isn't unique in a real document: "Warm Up", "Exercices", and similar section
titles repeat across a unit. A stored heading is either a bare string, valid only when that exact
text is unique in the document, or a `{ heading, slide }` pair that pins the specific occurrence by
the `<!-- slide N -->` in effect at that heading. Extraction and `--map-existing` always ask the
model for a slide (given a "document headings, with slides" index alongside the raw content) and
simplify the result to a bare string afterward wherever the text turns out to be unique, so the
stored form stays minimal without ever trusting the model to know in advance which headings need
disambiguating.

A topic's stored `headings` are also collapsed against each other: an exact duplicate, or a heading
whose resolved section already contains another listed heading's occurrence (a `##` parent and one
of its own `###` children, both assigned to the same topic), is dropped so the same content is never
counted twice. This runs wherever a topic's headings are read (so stale, pre-collapse data is safe)
and wherever a final heading list is about to be stored or written to a proposal.

The topic → heading review output (printed by plain extraction and by `--map-existing`, both the
model path and `--from-proposal`) ends with a **WARNINGS** section: non-blocking, deterministic
hints grouped by type, covering identical content across topics, one topic's content sitting
entirely inside a single other topic's content (a parent heading and one of its own children,
assigned to two different topics, so `collapseNestedHeadings` never sees them together), a topic's
content falling under a small character threshold, a single section linked by three or more topics,
and a topic whose linked headings share no meaningful word with its own name. None of these fail the
run; a unit can legitimately have topics that share a practice slide or use different wording than
their heading.

```bash
npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id>
npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id> --map-existing [--write-db]
npx tsx apps/pipeline/src/commands/content-suggest-topics.ts <markdown-file> <unit-id> --map-existing --from-proposal <path> [--write-db]
npx tsx apps/pipeline/src/commands/content-suggest-topics.ts --consolidate
```

`--consolidate` runs cross-unit topic consolidation instead of extracting from a single file.

`--map-existing` repairs headings for `<unit-id>`'s existing topic *names* without re-extracting
the names themselves, for a unit whose topic names are already fixed (e.g. questions have been
generated against them) but whose headings need rebuilding. It writes a proposal (per-topic
headings, section count, character count, and slide range) to
`content/exports/heading-repair-<unit-id>.{json,md}`; add `--write-db` to also write the repaired
headings to the `units` table.

`--from-proposal <path>` applies a proposal file (typically the previous run's output, hand-edited
to fix mapping mistakes) instead of calling the model: it validates every heading the same way,
prints the same review table, and writes only `headings` (topic names and every other unit field
are untouched). No model call. Otherwise this script has no database-write flags, and no logging
flags.

**Any existing unit must be mapped with `--map-existing` before its topics can generate anything.**
A unit's `headings` predating exact-heading matching (word tokens like `["révision:", "present",
"tense"]` rather than verbatim heading text) will never resolve under the current matching rule.
`questions-generate.ts` and `content-extract-resources.ts` both check this before doing anything
else and exit with an error naming the unit and every mismatched heading; see their sections
below.

### content-extract-resources.ts

Extract learning resources (YouTube URLs, etc.) from markdown files.

```bash
npx tsx apps/pipeline/src/commands/content-extract-resources.ts [options]

Options:
  --unit <unit-id>    Extract for a specific unit (default: all)
  --force             Re-extract even if resources exist
  --dry-run           Show what would be extracted (default unless --write-db)
```

Plus the shared Database target and Logging flags above.

Before scanning any unit, validates every topic's stored `headings` against that unit's current
markdown (see `content-suggest-topics.ts` above) and exits non-zero, naming the unit and every
mismatched heading, if any topic's headings don't resolve. A topic with no stored headings at all
is unaffected: it uses the name-substring fallback and isn't subject to this check.

### questions-generate.ts

Stage 1 (generation) + Stage 2 (validation). Hybrid model: Haiku for beginner/intermediate MCQ and true-false, Sonnet for typed answers and everything at advanced difficulty.

Before generating anything, validates every topic's stored `headings` against the unit's current
markdown the same way `content-extract-resources.ts` does, for every unit the run would touch.
This is what catches a unit whose headings predate exact-heading matching, rather than letting the
run "succeed" having generated zero questions.

The generation prompt (`prompts/questions-generate.md`) uses a topic's extracted content to set
scope, not correctness: it teaches which vocabulary, grammar, and cultural topics to test, but the
French and the facts in every question must be correct even when the material itself contains an
error. The model is asked for "up to" the question count per topic/difficulty (see `--count` below);
returning fewer is expected for thin topics and isn't retried.

```bash
npx tsx apps/pipeline/src/commands/questions-generate.ts [options]

Options:
  --unit <unit-id>              Filter by unit id
  --topic <name>                Generate for specific topic only
  --difficulty <level>          beginner | intermediate | advanced
  --type <type>                 multiple-choice | true-false | fill-in-blank | writing
  --writing-type <wtype>        Writing subtype (requires --type writing)
  --count <n>                   Questions per topic/difficulty (default: auto — a per-topic cap
                                 computed from content length, 2-10; overrides it for the whole run)
  --batch-id <id>                Custom batch ID (default: generated from date + timestamp)
  --source-file <path>           Source learning material file path, for tracking
  --model <model-id>             Override model for all types (disables hybrid mode)
  --skip-validation              Skip answer validation (faster, no variation generation)
  --generation-model-structured <id>  Override structured question generation model
  --generation-model-typed <id>       Override typed question generation model
  --validation-model <id>             Override answer validation model
  --dry-run                     Show what would be generated without generating
```

Plus the shared Database target and Logging flags above.

### questions-plan.ts

Analyze current question distribution and plan targeted generation.

```bash
npx tsx apps/pipeline/src/commands/questions-plan.ts [options]

Options:
  --execute            Execute the generation plan (prompts for confirmation)
  --analyze-only       Only show distribution analysis, don't generate a plan
  --target-writing <n> Target percentage for writing questions (default: 27)
```

Plus the shared Logging flags above. This script has no `--write-db`; `--execute` prompts interactively before spawning generation.

---

### questions-audit.ts

Stage 3 quality audit, both auditors. `--auditor mistral` (the default) applies a 6-criteria gate
plus remediation (difficulty relabeling, variation removal); `--auditor sonnet` applies a narrower
4-criteria gate (answer_correct, grammar_correct, no_hallucination, question_coherent) with no
remediation, for comparison runs against the Mistral auditor. With `--write-db`, both auditors write
each group's results to the database as soon as that group's audit call completes, rather than
waiting for the whole run. An interrupted run (crash, Ctrl-C) keeps whatever it already wrote.

Every question is audited alongside an excerpt of the course material its topic was generated from
(same `extractTopicContent` call Stage 1 makes, grouped by distinct topic and truncated per topic,
per `AUDIT_MATERIAL_CHARS_PER_TOPIC` in `learning-materials.ts`), so the auditor can tell taught register,
slang, and idiom apart from an actual error instead of guessing from general knowledge. The material
only settles what's linguistically in scope; it's never taken as authority on facts: a statistic,
date, or historical/cultural claim (including sample warm-up/discussion answers, which the material
often states as fact but are just as often a student's imprecise answer) is still judged for accuracy
even when the material states it verbatim.

Before auditing, `auditHeadingPreflight` runs two gates and exits naming the problem, before any
model call: the same stale-heading check `questions-generate.ts` runs (a topic whose stored headings
no longer resolve against its unit's markdown), plus a second check that every audited question's
`(unit, topic)` pair actually resolves to non-empty content, catching a headingless topic whose
name-substring fallback also fails to match anything, and an unknown unit or topic, neither of which
the first check inspects. `--allow-missing-material` skips the second gate for an operator who has
confirmed the gap and wants to audit anyway without reference material for those topics.

`--pending-only` limits a run to never-audited questions and picks up where an interrupted run left
off. Omitting it re-audits a batch's `active` and `flagged` questions too, and writes whichever
verdict the new run reaches in either direction: a question can move from `active` to `flagged` on a
newly-caught error, or from `flagged` back to `active` once a prompt fix clears a false positive.

```bash
npx tsx apps/pipeline/src/commands/questions-audit.ts [options]

Options:
  --auditor <mistral|sonnet> Auditor to use (default: mistral)
  --unit <unit-id>         Filter by unit
  --difficulty <level>     Filter by difficulty
  --type <type>            Filter by question type
  --writing-type <wtype>   Writing subtype (requires --type writing)
  --batch-id <id>          Filter by batch_id
  --model <id>             Filter by generator model (sonnet only)
  --limit <n>              Random sample of N questions
  --pending-only           Audit only pending questions
  --allow-missing-material Skip the material-resolution preflight and audit anyway when a topic resolves to no reference material
  --output <path>          Export results to JSON
  --llm-batch              Submit as an OpenRouter batch instead of auditing synchronously (mistral only)
  --llm-batch-resume <id>  Poll a submitted batch job; combine with --write-db to apply results once complete (mistral only)
```

Plus the shared Database target and Logging flags above. `--llm-batch`/`--llm-batch-resume` are
rejected with `--auditor sonnet`, which audits synchronously only.

`--llm-batch` submits the audit as an OpenRouter batch job (Mistral Large 3) instead of calling the
sync endpoint per group, and records the job in `llm_batch_jobs`. Resume with `--llm-batch-resume
<job-id>` to poll it; add `--write-db` to apply results once the batch completes. A whole-batch
pre-execution failure falls back to the sync endpoint (`mistralai/mistral-large-2512`) automatically when resumed
with `--write-db`. Batch mode is opt-in; the default (no flag) audits synchronously.

---

### db-export-questions.ts

Export the questions table to JSON, for inspection, archival, or cross-model audit.

```bash
npx tsx apps/pipeline/src/commands/db-export-questions.ts [options]

Options:
  --output <path>       Output file (default: content/exports/corpus-export.json)
  --columns <mode>      minimal (default) or full
  --unit <unit-id>      Filter by unit
  --difficulty <level>  Filter by difficulty
  --type <type>         Filter by question type
  --writing-type <wtype> Writing subtype (requires --type writing)
  --batch-id <id>       Filter by batch_id
```

Plus the shared Logging flags above.

### db-seed-study-code-words.ts

Seed `study_code_source_words` with adjective/animal word pools used to generate anonymous study codes.

```bash
npx tsx apps/pipeline/src/commands/db-seed-study-code-words.ts [options]

Options:
  --count <n>    How many of each category to sample (default: 200)
  --dry-run      Show what would be inserted (default unless --write-db)
```

Plus the shared Database target and Logging flags above.

### db-check-connection.ts

Verify Supabase connectivity and schema for all core tables. No options.

```bash
npx tsx apps/pipeline/src/commands/db-check-connection.ts
```

This is the one script that calls `assertSupabaseTarget({ write: true })` directly rather than going through `createScriptSupabase()`, since it always inserts and deletes a test row.

---

### Evaluation framework

The seven `eval-` commands below test whether a different model, provider, or setting would do as
well or better than what production currently uses on the audit, grading, mapping, or transcription
task, on a frozen sample and through the exact prompt builder and parser production itself calls, so
a candidate is judged on the same conditions it would actually run under. See
[`docs/pipeline-architecture.md#evaluation-framework`](../../docs/pipeline-architecture.md#evaluation-framework)
for the table shapes and the durable experiment/model-registry/findings layer above them, and
[`docs/cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models`](../../docs/cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models)
for a full workflow walkthrough.

### eval-experiment-create.ts

Validates and creates (or updates) one `eval_experiments` row: the named question an evaluation
program is testing, before any run is attributed to it. Dry run by default, printing the row it
would insert (or the patch it would apply) plus which `eval_models_current` row each declared
variant's `model_slug` resolved to; `--write-db` persists it.

`--tasks` accepts the task vocabulary in `apps/pipeline/src/lib/eval/types.ts`; `generation` and
`validation` are accepted but warned about, since no `eval-run` runner exists for either yet.
`--variants` is a path to a JSON array of `{label, model_slug, role, settings?}`: `label` must be
non-empty and unique within the file; `model_slug` must resolve against `eval_models_current` unless
it is `'*'` (matches any model); `role` is one of `baseline`, `candidate`, `exclusion_pass`,
`step_down`, `cross_vendor`, `specialist`, `prompt_variant`, or `successor` (the vocabulary existing
rows use); `settings`, when given, is limited to the repeat-identity keys `eval-run` itself writes
(`temperature`, `reasoning`, `provider`, `groupSize`, `shuffleSeed`, `exclusionPass`, `renderDpi`,
exported from `eval-run.ts` as `REPEAT_IDENTITY_SETTINGS_KEYS` rather than re-listed here), each
checked against the shape `eval-run` actually writes for it (for example `provider` as a bare pin
string or an `{order: [...]}` object, `renderDpi` as a whole number from 72 to 400). `--decision-rule`
is a path to a JSON object limited to the keys `resolveTolerance()` (`tolerances.ts`) knows:
`tolerance`, `precisionTolerance`, `maxSlideDrop` (each a number between 0 and 1), and `description`,
refusing an unrecognized key outright rather than warning, since this is creation time, before
anything has run under it. `--depends-on` is a comma-separated list of experiment slugs, each
checked to exist. `--status` accepts only `proposed` or `running`; `decided`, `deferred`, and
`superseded` are set exclusively by `eval-compare --decide`.

`--update <slug>` replaces any subset of `--question`, `--variants`, `--decision-rule`,
`--depends-on`, `--notes` on an existing experiment, through the same validation. `--slug` cannot be
combined with `--update` (the slug is the public identifier and is never edited); `--tasks` and
`--status` cannot be changed this way either (a task list is fixed at creation, and status moves only
through `eval-compare --decide`). An update that would drop a declared variant (by its `label`) that
already has matching `eval_runs` rows is refused, read through `eval_experiment_variants` with that
view's own match rule, so an edit can never silently orphan a run's attribution.

```bash
npx tsx apps/pipeline/src/commands/eval-experiment-create.ts --slug <slug> --question "<text>" --tasks <task,...> --variants <path.json> [options]

Options:
  --slug <value>              Lowercase letters, digits and hyphens; the public identifier (required to create; refused together with --update)
  --update <value>             Slug of an existing experiment to update, instead of creating a new one
  --question <value>           The falsifiable question this experiment answers (required to create)
  --tasks <value>              Comma-separated task(s) this experiment covers (required to create; fixed after creation)
  --variants <value>           Path to a JSON array of {label, model_slug, role, settings?} (required to create)
  --decision-rule <value>      Path to a JSON object of decision-rule overrides (tolerance, precisionTolerance, maxSlideDrop, description)
  --depends-on <value>         Comma-separated experiment slugs this one depends on
  --status <proposed|running>  Initial status (default: proposed); decided/deferred/superseded come only from eval-compare --decide
  --notes <value>              Free text notes
```

Plus the shared Database target and Logging flags above.

### eval-set-create.ts

Samples a frozen, hashed item set (`eval_sets`/`eval_items`) for the audit, grading, mapping, or
transcription task. Dry run by default; `--write-db` persists it. See [`docs/pipeline-architecture.md`](../../docs/pipeline-architecture.md#evaluation-framework) for the table shapes and
[`docs/cli-guide-content-ingestion-and-question-pipeline.md`](../../docs/cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models) for the full workflow.

For `--task mapping`, one item is created per topic of `--unit`, with reference set immediately from
the unit's own current, already-validated headings (there's no reviewer step for this task). The
command refuses if any topic has no headings. Repair it first with `content-suggest-topics
--map-existing`.

For `--task transcription`, `--per-category` slides are drawn from each of three slide categories:
image-dominated and text slides straight from `--report`'s own categorization, plus a "mixed" category
derived from text-layer length that production doesn't track itself. Refuses if a category has fewer
slides than requested. Reference is left pending; fill it in later with `eval-review-export`/`eval-review-import`.

```bash
npx tsx apps/pipeline/src/commands/eval-set-create.ts --task <audit|grading|mapping|transcription> [options]

Options:
  --task <audit|grading|mapping|transcription>  Which task this set samples items for (required)
  --from-batch <id>          Restrict to questions from this batch_id
  --unit <unit-id>           Unit id this set is drawn from, recorded as eval_sets.unit_id (required)
  --markdown <path>          Path to the unit markdown file (required for --task mapping)
  --strata <fields>          Comma-separated question fields to stratify the audit sample by (default: type,difficulty,quality_status)
  --size <n>                 Sample size (required for --task audit)
  --seed <n>                 Random seed for the sample
  --include-ids <path>       File of question ids (one per line) to restrict sampling to (audit)
  --exclude-topics <path>    File of topic names (one per line, exact match) to exclude before sampling (audit)
  --balance-status           Oversample flagged questions to half the audit sample
  --pool-ids <path>          File of candidate ids to draw --pool-size additional items from, after the stratified core (audit)
  --pool-size <n>            Additional items to draw from --pool-ids, tagged payload.selection_pool: "pool" (audit; requires --pool-ids)
  --per-question <n>         Grading label classes to seed per question (default: 6)
  --pdf <path>               Path to the source PDF (required for --task transcription)
  --report <path>            Path to that PDF's *.conversion-report.json (required for --task transcription)
  --per-category <n>         Slides to draw from each of the three slide categories (required for --task transcription)
  --label <text>             Human-readable label for this set (required)
```

Plus the shared Database target and Logging flags above.

### eval-seed-grading.ts

Fills a grading eval set's `submitted_answer` placeholders. `typo` and `missing_accent` are
computed deterministically from the correct answer; the other four label classes go through one
model call per question. Every item stays `reference_status: 'pending'` until reviewed in the Supabase
table editor; an item with no valid deterministic answer is marked `reference_status: 'rejected'` with a
note instead. Dry run by default (prints pending items by label class, the deterministic answers,
and the projected cost of the model calls still needed, with no model call); `--write-db` actually
calls the model and persists answers.

```bash
npx tsx apps/pipeline/src/commands/eval-seed-grading.ts --set <id> --model <slug> [options]

Options:
  --set <id>      eval_sets id (grading task) to seed (required)
  --model <slug>  Model slug used to write the four model-seeded label classes (required)
```

Plus the shared Database target and Logging flags above.

### eval-run.ts


Runs one or more model variants against a frozen eval set through the production prompt builder
and parser (`callMistralAuditGroup` for audit, `buildEvaluationPrompt`/`parseEvaluationResponse`
for grading, `buildMapExistingPrompt`/`parseMapExistingResponse` for mapping, `pdf-conversion.ts`'s
own slide renderer and transcription prompt for transcription). Audit, grading, and transcription
variants are interleaved in blocks of 25 items; audit items are further grouped by `--group-size`
(default 1, matching production's `AUDIT_GROUP_SIZE`: each question audited alone,
with no neighbours sharing the call). A larger value groups multiple questions into one call.
`--shuffle-groups <seed>` permutes item order with a seeded RNG before grouping, so a repeat run can
be deterministically regrouped rather than only rerun with the same groups, measuring the audit's
sensitivity to which questions share a call. Mapping sends
every item (topic) in the set in a single call per variant per repeat, matching production's own
`mapExistingHeadings` (one call, the whole topic list and unit markdown at once). `--group-size`
and `--shuffle-groups` have no effect on it. Each task defaults to production's own call settings
(audit: temperature 0.1, JSON mode, pinned to Mistral; grading: `GRADING_CALL_SETTINGS`; mapping and
transcription: no temperature override, no JSON mode, no provider pin) unless
`--temperature`/`--provider` override them, so an unlabeled baseline run reproduces what production
actually sends. A `--provider` value is lowercased before it's recorded as `provider_pin` and
`settings.provider`, so `--provider Anthropic` and `--provider anthropic` are stored identically. Projects each variant's cost before it starts and refuses to run a variant over
`--max-cost`, including one with no listed price unless `--allow-unpriced` is given: the projection
accounts for `--group-size` on the audit task, since a smaller group needs more calls and repeats
more of the shared material per item; mapping always projects a single call regardless of item
count, since that's how many the runner actually sends.

Transcription renders each slide's image once per invocation (shared across every variant and
repeat, since the image doesn't depend on which model transcribes it), but never reads the
production slide cache: every kept slide is sent to the model on every call. A cached transcript
would record zero cost and disk latency and make repeats of a baseline identical by construction,
which is not the noise floor being measured. `--render-dpi <n>` (72 to 400, default 120) overrides
the resolution slides are rendered at
before being sent to the model; production and `eval-judge` always render at 120, so a `--render-dpi`
run measures the transcription model's sensitivity to image resolution rather than production
behaviour. The resolved value is recorded as `settings.renderDpi` on the run (`null` for every other
task).

Transcription also accepts `--exclusion-pass <model>`, a separate teaching-content classifier that
gates each slide before the transcription call: a slide it judges not to teach the course language
gets the no-content marker directly, with no transcription call made for that slide. The classifier
call honours `--provider` by default; `--exclusion-provider <tag>` overrides that when the
classifier's own model needs a different one. The run's `settings.exclusionPass` and each result's
`deterministic_checks.exclusion_decision`/`exclusion_reason` record the gate's model, provider, and
verdict; cost projection adds one classifier call per slide at the classifier model's registry
price, and each result row's `cost_usd` sums both calls when the slide was kept.

Before anything runs, `--models` is resolved against `eval_models_current` (the latest registered
snapshot per slug) and `--experiment`, if given, against `eval_experiments`; either a model with no
registry row or an unresolvable experiment refuses to start the whole invocation: the same style as
the budget-cap refusal below, printing what's missing rather than running with a gap.

A model's sampling constraints, resolved once per distinct model, adjust the task's intended
temperature or default-disabled reasoning before its calls go out: `temperature` is dropped
outright for a model `MODEL_CONSTRAINTS` (`@adaptive/shared/models`) flags as requiring its own
fixed default, and a task that would otherwise send `reasoning: { enabled: false }` sends an effort
tier instead when the model's own registry row (`eval_models_current.reasoning`) says reasoning is
mandatory, sending the lowest entry of that row's registered `efforts` list (ranked `minimal < low
< medium < high < xhigh < max`), or `low` with a logged warning when the row has no recognized
efforts list. An explicit `--reasoning` is a deliberate choice and is never adjusted this way; it's left to
fail if the model rejects it. Each adjustment is logged once per variant, and the values actually
sent are recorded as `settings.effectiveTemperature`/`settings.effectiveReasoning` alongside the
intended `settings.temperature`/`settings.reasoning`.

A resolved run stamps `experiment_id` and `model_version_id` on its `eval_runs` row, and each call's response stamps
`served_provider` on its `eval_results` rows alongside the existing `served_model` (what OpenRouter
actually served, as distinct from `--provider`'s request). Every finished run's `summary` also gets a
top-level `primary_metric: {name, value, direction}`, the value the comparison views select
generically across tasks. Alongside `summary`, the same write stamps `eval_runs.scored_at` (when this
summary was computed) and `eval_runs.scoring_review_round_id` (the newest `eval_review_rounds` row on
the set at that time, or null when the set has none) through `stampSummary`
(`apps/pipeline/src/lib/eval/summary-stamp.ts`), the one helper `eval-run.ts` and `eval-rescore.ts`
both call so the two never diverge on where scoring provenance lives; it is columns, not keys inside
`summary`.

Every variant's `eval_runs` row reaches a terminal status before the process exits: `completed` on a
normal finish, `failed` (with the error message in `summary.error`) either when something outside
the per-item error handling breaks that variant without stopping the others, or when every one of
its result rows carries a non-null `error` (every call errored individually, e.g. a model that
rejects the task's reasoning setting), and `aborted` for every non-errored variant when SIGINT is
received (finishing the call already in flight first, then stopping). A row is never left `running`.

Every run's `variant_label` is always `<label>:<model slug>`, whether this invocation runs one
variant or several, with no `:r<n>` repeat suffix; that distinction lives in `repeat_index`
instead. `--label` defaults to the experiment slug when `--experiment` is given, else the task
name, so a run is never left unlabeled; labels written before this convention may differ.
`repeat_index` is the invocation's own repeat offset for an ad hoc run with no `--experiment`,
restarting at 1 per invocation. With one, it is one more than the number of existing runs already on
that experiment for the same set and model, excluding `failed` and `aborted` runs (neither produced
a usable result), judged by prompt hash and the caller-controlled settings (`temperature`,
`reasoning`, `provider`, `groupSize`, `shuffleSeed`, `exclusionPass`, `renderDpi`; the derived
`effectiveTemperature`/`effectiveReasoning` don't count, since they follow from the model's sampling
constraints rather than anything asked for), plus the invocation's own offset. A settings key
missing on a run's stored settings compares against the value that was actually in force when it
ran, not a wildcard: `temperature` absent means no override was sent (mapping and transcription
write no `temperature` key at all unless `--temperature` overrides it, so this is their steady
state, not just a historical gap), `reasoning`/`shuffleSeed`/`exclusionPass` absent means `null`,
`provider` absent means unpinned (and present values compare case-insensitively), `groupSize` absent
means the task's own default, `renderDpi` absent means the pre-flag default of 120. This
normalisation lives in one exported function, `normalizeRepeatIdentitySettings`, so a verification
script can reproduce the grouping directly against stored rows. The count is resolved once per
distinct model before any run in the invocation is inserted, so several repeats of the same model in
one invocation get consecutive numbers; a repeat launched by hand in a later invocation continues the
count instead of restarting at 1, and a changed setting (`--render-dpi`, a different `--temperature`,
...) starts its own count from 1.

The identity is keyed on what was requested, not on what was actually sent to the model: on a task
where a setting already defaults to the value a flag would set, passing the flag anyway and omitting
it are different identities even though the call itself is identical. `--reasoning off` and no
`--reasoning` flag at all are different identities on a transcription run, for example, since
transcription never sends reasoning by default either way but the two are recorded as
`settings.reasoning` `{enabled: false}` versus `null`.

```bash
npx tsx apps/pipeline/src/commands/eval-run.ts --set <id> --task <audit|grading|mapping|transcription> --models <slug>[,<slug>...] [options]

Options:
  --set <id>            eval_sets id to run against (required)
  --task <audit|grading|mapping|transcription>  Must match the set's own task (required)
  --models <slugs>      Comma-separated OpenRouter model slugs, one variant each (required)
  --provider <tag>      Provider tag to pin every variant to
  --reasoning <value>   off, or an effort tier (none|minimal|low|medium|high), for every variant
  --temperature <n>     Overrides the task's production temperature for every variant
  --repeat <n>          Repeats of each model, each its own eval_runs row (default: 1)
  --experiment <id|slug>  eval_experiments id or slug to attribute these runs to — resolved and stamped as experiment_id on each eval_runs row
  --label <text>        Label recorded on each run as <label>:<model slug>; defaults to the experiment slug when --experiment is given, else the task name
  --max-cost <usd>      Refuses to start any single variant whose projected cost exceeds this (default: $2)
  --allow-unpriced      Run a variant even when its model has no listed price, so its cost cannot be projected or capped (default: false)
  --group-size <n>      Audit task: questions sharing one audit call (default: 1, matching production; a larger value groups multiple questions into one call)
  --shuffle-groups <n>  Audit task: seed permuting item order before grouping, so a repeat can be deterministically regrouped
  --exclusion-pass <model>     Transcription task: model slug for a teaching-content classifier gating each slide before its transcription call (off by default)
  --exclusion-provider <tag>   Provider tag to pin the --exclusion-pass call to, when it must differ from --provider
  --render-dpi <n>      Transcription task: resolution the slide images are rendered at before being sent to the model (72 to 400, default: 120)
```

Plus the shared Database target and Logging flags above. A Mistral-family model is throttled to one
request per second regardless of interleaving.

### eval-rescore.ts

Recomputes a completed run's per-item scores and `eval_runs.summary` from what's already stored, with
no model call: for a run whose task scores against a reviewed reference and finished before that
reference existed, or after a summary field changes so it's computed from data every stored row
already carries. Targets exactly one of `--run`, `--set` (every completed run against that set), or
`--experiment` (every completed run attributed to it, id or slug). A run whose status isn't
`completed`, whose set has no items, or that has no `eval_results` rows is skipped with a message
rather than failing the rest. Per-item `score` is only ever touched for transcription and mapping,
the two tasks whose score is computed against a reference; grading's is the model's own self-score
and audit has none. `status` and `finished_at` are never touched, but `scored_at` and
`scoring_review_round_id` are refreshed to the rescore's own time and the set's current newest
review round, through the same `stampSummary` helper `eval-run.ts` uses. Dry run by default,
printing each run's task, variant label, old and new `primary_metric`, and how many item scores
would change; `--write-db` performs the writes.

```bash
npx tsx apps/pipeline/src/commands/eval-rescore.ts (--run <id> | --set <id> | --experiment <id|slug>) [options]

Options:
  --run <id>          eval_runs id to rescore
  --set <id>          eval_sets id, rescoring every completed run against this set
  --experiment <id|slug>  eval_experiments id or slug, rescoring every completed run attributed to it
```

Plus the shared Database target and Logging flags above.

### eval-compare.ts

Paired comparison of candidate runs against a baseline run on their shared, reference-approved items:
agreement, McNemar's exact test, a 95% confidence interval on the difference, the non-inferiority
verdict against a resolved tolerance, and the noise floor from any repeats of the same model
among the runs given. Always writes the markdown report; dry run by default otherwise, `--write-db`
additionally updates each run's own `eval_runs.summary.compare`.

The tolerance a verdict is judged against comes from the candidate's own `eval_experiments` row,
never the baseline's: with `--candidate`, that run's `experiment_id`; otherwise, the one experiment
every candidate in `--runs` shares. A baseline run is routinely reused across many later
experiments, so its own `experiment_id` carries no rule relevant to this comparison. Candidates
citing more than one experiment with no `--candidate` to disambiguate are refused outright, naming
the experiments. The resolved experiment's `decision_rule` can carry a numeric override: `tolerance`,
`precisionTolerance` (audit's secondary precision check), or `maxSlideDrop` (transcription's
per-slide limit), alongside a `description` string for a human reading the experiment record;
falling back to the task's own default (`TASK_TOLERANCES` in `tolerances.ts`) when the resolved
experiment has none, or there is no experiment at all. A `decision_rule` key other than those four is
ignored and logged as a warning rather than silently applied or refused. The report's "Tolerance:"
line always states which rule applied and the experiment it came from: `task default`, or
`experiment override: <key> <value>[, ...]`, each suffixed `(from experiment '<slug>')` when the
rule came from one. The report also prints, per candidate against the baseline, whether they share
`prompt_hash` and how they compare on serving host: when both runs are pinned, whether the pins
agree; when either is unpinned, which hosts the results record as having served each run, or
"served hosts not recorded" when a run carries none. A warning line follows whenever either
differs or is unknown, since both are confounds beyond the model itself.

The mapping and transcription tasks get their own report shape, since their primary metric
(per-topic heading-set F1, or `1 - normalized edit distance` against a checked transcript, both in
`eval_results.score`) is continuous rather than a per-item pass/fail: each run's own mean score with
a 95% CI, cost and latency, plus task-specific stats (mapping: fraction of topics scored a
perfect 1, summed unresolved-heading and nested-duplicate counts; transcription: worst slide, mean
text coverage, no-content and table-structure agreement with reference); the per-item score difference
against the baseline with its CI, the better/worse/tied split and an exact sign test over the
non-tied items; and the noise floor from any repeats as the mean absolute score difference between
them. Mapping's reference is always approved at `eval-set-create` time, so there's no reference-free fallback
for it. Transcription's reference is reviewed after the fact like audit/grading, so a set with no approved
reference yet falls back to a reference-free report: agreement between each candidate's and the baseline's own
transcript, by the same edit-distance similarity, clearly labelled as not an accuracy figure.

Grading's non-inferiority verdict is the paired statistic directly (false-negative rate is already
single-valued). Audit's real tolerance is six per-criterion recall/precision numbers, so the paired
statistic pooled across all six is reported as informational only ("correlated pairs" in the
report); the real headline is a separate per-criterion verdict, each criterion checked
independently against its own tolerance (recall -3pp, precision -5pp), reading "All criteria pass"
or naming the ones that failed.

When the eval set has no approved reference items, there is no accuracy verdict to compute against.
The command does not exit; it reports stability and agreement instead: item-level verdict agreement
between each candidate and the baseline (each run's own verdict, not checked against anything),
per-criterion flip counts and flag rates for audit, cost and latency per run, and the noise floor
from any repeats, labelled `identical-groups` or `different-groupings` from the repeats' recorded
`--group-size`/`--shuffle-groups` settings: a same-group repeat's disagreement is the run-to-run
noise floor, a different-grouping repeat's is the audit's group-context sensitivity. The report is
headed "no reference: stability and agreement only; no accuracy verdict" so it can't be mistaken for the
reference-backed one.

For audit runs, both the reference-backed and reference-free reports also list every item where the compared
runs' verdicts disagree, with each run's per-criterion verdict and its auditor's stored `notes`, so
a human can adjudicate which one is right, capped at 60 items with a count of the rest.

Transcription's non-inferiority verdict runs on words captured (the formatting-blind word recall
against the checked transcript, so a table where the reference used a list is not an error) and
has per-slide conditions beyond the mean tolerance: on any slide scored in both runs, a candidate
that falls too far below the baseline's own word recall on that slide (content lost) or the
baseline's word precision on that slide (content added that is not on the slide) is not
non-inferior, regardless of the mean. Without reference transcripts the same checks run on the
edit-distance score. Any run whose results named a `served_provider` other than its
own `provider_pin` is flagged with a warning: comparing normalized forms (lowercased, punctuation
stripped, and only the part of the pin before a `/` host-routing suffix), so `--provider anthropic`
isn't flagged against OpenRouter's `Anthropic`, or a pin like `mistral/zdr` against a plain
`Mistral` response.

`--write-db` only ever persists the comparison into `eval_runs.summary.compare`. It never touches
`eval_findings` or an experiment's status, on any task, no matter how many times it's rerun.
Recording an actual decision is a separate, explicit step: `--decide <adopt|reject|defer>` plus a
required `--statement "<one line>"`, which also requires `--write-db` and a candidate run that
carries an `experiment_id` (an ad hoc run made without `eval-run --experiment` has no experiment to
decide). With more than one candidate in `--runs`, `--candidate <run_id>` says which one. `adopt` is
refused unless that candidate's comparison produced a non-inferior verdict against a reference
(audit, grading, or transcription); `reject` and `defer` need no verdict, since either can be a
judgment call the numbers alone don't settle. Mapping never has a verdict to check, so only
`reject`/`defer` apply to it. Recording a decision writes one `eval_findings` row citing both
compared run ids and moves the experiment to `decided` (adopt/reject) or `deferred` (defer). Since
`eval_findings` is append-only, a second decision citing the same baseline/candidate pair under the
same experiment is refused unless `--supersedes <finding_id>` names the earlier one.

`--decide` also requires attribution: `decided_by` names the operator who ran this command, from the
explicit `--decided-by <name>`, or else the `EVAL_DECIDED_BY` environment variable. `--decide`
refuses when neither is set. The column names who recorded the row, not necessarily who made the
underlying call; `--statement` is where a ruling's actual origin is recorded.

```bash
npx tsx apps/pipeline/src/commands/eval-compare.ts --runs <id,id,...> --baseline <id> [options]

Options:
  --runs <ids>                Comma-separated eval_runs ids to compare (baseline is added automatically if omitted) (required)
  --baseline <id>             eval_runs id to treat as the baseline variant (required)
  --out <path>                Markdown report path (default: .private/eval/reports/eval-compare-<timestamp>.md, or $EVAL_REPORTS_DIR if set)
  --include-rejected-keys     Grading task: include items whose question key the reviewer marked Incorrect in the accuracy figures (excluded by default)
  --decide <kind>             adopt|reject|defer: records the decision as an eval_findings row and moves the experiment to decided (adopt/reject) or deferred (defer); requires --write-db, --statement, and attribution, and a candidate run with an experiment_id
  --statement <text>          One-line human-readable statement for the eval_findings row (required with --decide)
  --candidate <id>            Which of --runs the comparison's decision_rule (and, with --decide, the decision) is about; required with --decide, or with multiple candidates citing different experiments, when --runs names more than one
  --supersedes <id>           eval_findings id this decision supersedes — required to re-decide a pair an experiment already has a finding for
  --decided-by <name>         The operator running this command, recorded on the row; falls back to EVAL_DECIDED_BY, required with --decide
```

Plus the shared Database target and Logging flags above.

### eval-finding.ts

Records a plain observation as an `eval_findings` row: something worth writing down about the
evidence that is not itself an adopt/reject/defer decision on an experiment. `eval-compare --decide`
is the only other CLI route into this table, and it always moves the cited experiment's status, which
is wrong for an observation that stands on its own. `--experiment` and `--task` are both optional,
since an observation can predate a numbered experiment or not relate to one at all. `--runs` and
`--items` are the evidence this observation cites: each run id must resolve, and each item id must
belong to the set of at least one of the cited runs. `--supersedes <finding_id>` names an earlier
finding this one revises. `--kind` accepts only `observation`; `adopt`, `reject`, and `defer` stay
with `eval-compare --decide`. `decided_by` names the operator who ran this command: `--decided-by
<name>`, or else the `EVAL_DECIDED_BY` environment variable; `--write-db` refuses when neither is
set. It is not necessarily who made the underlying observation; `--statement`/`--evidence` is
where that origin is recorded. Dry run by default, printing the row it would insert. Never touches
`eval_experiments`.

```bash
npx tsx apps/pipeline/src/commands/eval-finding.ts --statement "<one paragraph>" [options]

Options:
  --experiment <id|slug>  eval_experiments id or slug this observation relates to
  --task <task>           Task this observation relates to
  --kind <observation>    Finding kind (default and only accepted value: observation)
  --statement <text>      One-paragraph human-readable statement of the observation (required)
  --evidence <text>       Narrative detail the statement alone cannot carry
  --runs <ids>            Comma-separated eval_runs ids cited as evidence
  --items <ids>           Comma-separated eval_items ids cited as evidence, each belonging to one of the cited runs
  --supersedes <id>       eval_findings id this observation supersedes
  --decided-by <name>     The operator running this command, recorded on the row; falls back to EVAL_DECIDED_BY, required with --write-db
```

Plus the shared Database target and Logging flags above.

### eval-judge.ts

A reference-free, paired judge comparison of two completed transcription runs on the same set, for
when scoring both against `eval-compare`'s checked-transcript reference isn't the question: that
reference was itself seeded from production's own model output, so a run compared through it is
partly scored against that model's own choices. `eval-judge` instead has a third model look directly
at the slide image, the PDF text-layer hint, and the two runs' transcripts (labelled A and B), and
pick the more complete and faithful one. Every shared item (present with non-error output on both
runs) is judged twice, with the two runs' positions swapped between the two calls, so a run wins the
item only when it wins in both orders; a split decision, or either call returning a tie, is a tie.
This cancels a judge's tendency to favor whichever transcript it sees first.

Dry run by default, printing the projected judge cost from the model registry's list price against
the same candidate budget cap `eval-run` uses; an unpriced judge model is refused unless
`--allow-unpriced`. `--write-db` calls the judge and, on each shared item's result row for both runs,
merges an entry into `eval_results.judge_verdict` keyed by the other run's id and then by the judge
prompt hash that produced it (`{"<other_run_id>": {"<judge_prompt_hash>": {"outcome", "judge_model",
"reasons", "judged_at"}}}`), merged rather than replaced, so a run judged against several others, or
re-judged against the same one under a changed prompt, accumulates one entry per (pairing, prompt).
Refuses to write over an existing entry for the same pairing and the current judge prompt hash
unless `--overwrite` is passed. Stamps `judge_model`/`judge_prompt_hash` on both `eval_runs` rows.
Prints items judged, wins for each run, ties, the item keys of every non-tie, and projected versus
actual judge cost.

```bash
npx tsx apps/pipeline/src/commands/eval-judge.ts --runs <run_a,run_b> --judge-model <slug> [options]

Options:
  --runs <ids>             Comma-separated eval_runs ids to judge against each other (exactly two, both completed transcription runs on the same set) (required)
  --judge-model <slug>     OpenRouter model slug for the judge (required)
  --provider <pin>         Provider tag to pin the judge call to (single upstream, fallbacks disabled)
  --allow-unpriced         Call the judge model even when it has no listed price, so its cost cannot be projected or capped
  --overwrite              Re-judge even when a shared item already carries a judge_verdict entry for this pairing under the current judge prompt hash
```

Plus the shared Database target and Logging flags above.

### eval-review-export.ts

Exports a frozen eval set's items for a human reviewer to fill in reference. Audit and grading get a
blind reviewer sheet (an `.xlsx` workbook by default, or `.csv` with `--format csv`) with no
`quality_status`, `audit_metadata`, production verdict, `selection_pool` tag, or (for grading)
`label_class`. Row order is shuffled with a seed, printed to the console (or pass `--seed` to
reproduce a shuffle); grading rows are further grouped by source question (`question_group`,
`Q1..Qn`), each group's answers shuffled within it, and `ref` (1..N) numbered after that ordering.
Transcription gets a directory instead: one `<slide>.md` file per item, since a transcript is
reviewed against the slide image rather than a row of cells. Prefilled with `--from-run`'s output
when given, plus a README.md listing every slide and its category. Read-only.

The `.xlsx` workbook holds one worksheet: row 1 is bold column headers, row 2 is an italic
per-column description of what it is and how to use it (both frozen so they stay visible while
scrolling); `item_id` (both tasks) and `difficulty` (audit) are hidden columns; the six audit
criteria, `borderline`, `key_incorrect` (grading), and `is_correct`/`borderline` (grading) carry a
dropdown list (`Pass`/`Fail`, `TRUE`/`FALSE`, `Correct`/`Incorrect`); `question`, `options`,
`acceptable_variations`, `student_answer`, and `reason` wrap text; and the sheet is protected with
every context column locked, leaving only the input columns (rows 3..N) editable. A multiple-choice
`answer_key` is prefixed with the option's 1-based position in `options` (exact text match) so a
reviewer can find it at a glance; if no option matches, the key is left unprefixed and a warning
names the item. The `.csv` fallback carries the same columns, `ref` numbering, and row-2
descriptions, just without formatting.

Grading's `key_incorrect`/`key_note` columns (immediately after `answer_key`) carry the reviewer's
verdict on the answer key itself, not the student's answer, and are editable only on each
`question_group` group's first row: every other row of the group has both cells locked, empty, and
filled light grey.

```bash
npx tsx apps/pipeline/src/commands/eval-review-export.ts --set <id> --out <path> [options]

Options:
  --set <id>       eval_sets id to export (required)
  --out <path>     Reviewer sheet output path (audit/grading), or a directory (transcription) (required)
  --format <fmt>   Audit/grading output format: xlsx (default) or csv
  --seed <n>       Random seed shuffling row order (default: a fresh seed, printed to the console) — audit/grading only
  --all-classes    Grading task: include typo/missing_accent items (excluded by default)
  --from-run <id>  Transcription task: eval_runs id whose output prefills each slide's file (default: empty files)
```

Plus the shared Database target and Logging flags above.

### eval-review-import.ts

Reads a reviewer's completed reference back and writes `eval_items.reference`. Audit and grading read a
reviewer sheet (`.xlsx` or `.csv`, detected by extension) from `eval-review-export`, skipping its
row-2 description row; transcription reads a directory of `<slide>.md` files (from the same
command's directory export). `item_id` is the sole join key. Validates everything before any write
: item existence and uniqueness, well-formed cells or non-empty files, and a required
`reason`/non-empty transcript wherever one is needed, and refuses to write anything if any of it
fails. `--policy-labels` (grading only) also approves every `typo`/`missing_accent` item directly,
without a sheet row for it. An item already `reference_status: 'approved'` is left alone unless
`--overwrite` is given. Dry run by default; `--write-db` performs the writes, then records one
`eval_review_rounds` row for the set with `reviewed_item_count` set to however many items this run
actually wrote.

A reference corrected outside this command (by hand, e.g. through the table editor) must still get
an `eval_review_rounds` row recorded for its set, not just an updated `eval_items.reference` and
`reviewed_at`: `eval_run_metric_status` treats a review round newer than the one a run was scored
against as its own "reference changed" signal, independent of `reviewed_at`, and a hand correction
that skips it is invisible to that check.

For grading, the key verdict is read once per `question_group` group rather than once per row:
`key_incorrect` checked (`TRUE`) on any row of the group means the key is wrong; blank/`FALSE`
elsewhere in the group is normal. `key_note` is required whenever the key is wrong, and disagreeing
`key_note` text across the group's rows is a validation error naming the group.

```bash
npx tsx apps/pipeline/src/commands/eval-review-import.ts --set <id> --from <path> --reviewer <handle> [options]

Options:
  --set <id>           eval_sets id to import reference into (required)
  --from <path>        Reviewer-completed .xlsx or .csv path (audit/grading), or reference directory (transcription), all from eval-review-export (required)
  --reviewer <handle>  Reviewer handle recorded as reviewed_by on each written item, and as the eval_review_rounds row's reviewer (required)
  --rubric-version <v> Label of the rubric this review round was labeled under, e.g. v1, recorded on the eval_review_rounds row (required)
  --rubric-hash <hash> Content hash of the rubric at labeling time, recorded on the eval_review_rounds row
  --calibration-result <json>  JSON object recording this round's calibration result, recorded on the eval_review_rounds row
  --sheet <name>       Worksheet (tab) to read from an .xlsx, matched exactly or by prefix (an .xlsx export truncates tab names to 31 characters); default is the first tab
  --policy-labels      Grading task: also approve every typo/missing_accent item directly
  --overwrite          Overwrite items already reference_status 'approved' (default: skip them)
```

Plus the shared Database target and Logging flags above.

---

## Shared Libraries

### lib/options/

`define-cli.ts` is the declarative option parser described above (schema in, `{ parse, help }` out). `groups.ts` holds the option groups shared across scripts (`dbTargetFlags`, `loggingFlags`, `questionFilterFlags`). `types.ts` has the supporting TypeScript types.

### lib/paths.ts

Directory anchors (`PIPELINE_ROOT`, `REPO_ROOT`, `COMMANDS_DIR`, `PROMPTS_DIR`, `PDF_DIR`, `MARKDOWN_DIR`, `EXPORTS_DIR`, `PDF_SLIDE_CACHE_DIR`) resolved from this file's own location, so they work whether a command runs from the repo root or from inside `apps/pipeline`.

### lib/env.ts

Loads the repo-root `.env.local` into `process.env`. Called from inside a command's `main()`, or by `db-queries.ts`'s Supabase client constructors, never at module scope, so importing a command to read its `cli` spec never reads an env file as a side effect.

### lib/run-if-main.ts

`runIfMain()` runs a command's `main()` only when its file is the process entry point, not when the dispatcher imports it to read its `cli` spec.

### lib/logger.ts

The pipeline-side structured logger: `createLogger(component)` returns an object with `debug`/`info`/`warn`/`error` methods, each tagged with the component name. `setLogLevel()` and `levelFromFlags()` wire a script's `--verbose`/`--quiet` flags to the process-global minimum level. Distinct from `apps/web/src/lib/logger.ts`, the server-side logger used by the Next.js app, which additionally silences `debug` on any deployed build.

### lib/pipeline-steps.ts

Step functions for the pipeline orchestrator. Used by `pipeline-run.ts`.

- `stepConvertPdf()`: PDF to Markdown conversion
- `stepExtractTopics()`: Topic discovery
- `stepAutoUpdateFiles()`: Auto-update the units table in the DB for new units
- `stepGenerateQuestions()`: Spawn question generation
- `stepAuditQuestions()`: Spawn quality audit
- `stepExtractResources()`: Spawn resource extraction

### lib/pdf-conversion.ts

Renders every PDF page (one slide) as an image and transcribes it with a vision model
(`MODELS.pdfConversion`), pairing the image with that slide's `pdftotext` text
layer as an unreliable hint: course slides are frequently screenshots whose
teaching text lives in the image, not the extractable text. Per-slide output
is cached on disk (content-hash keyed on the slide image, text layer, prompt,
and model) so reruns don't re-pay for unchanged slides. Slides are transcribed
with bounded concurrency; a slide that fails twice fails the whole conversion
with its slide number rather than being silently dropped. Output slides are
joined with `<!-- slide N -->` markers. A slide the model correctly judges to
have no teaching content is reported as skipped, not flagged; a slide with a
real text layer (5+ qualifying words) is flagged when the output covers less
than 80% of it. A slide whose text layer is just a title or label is excluded
from that check entirely: nothing meaningful to compare it against. A
per-PDF `<name>.conversion-report.json` lists flagged slides, skipped slides
(with a text-layer preview), and slides whose text layer was thin enough to be
image-dominated. Requires `pdftotext`, `pdftoppm`, and `pdfinfo` (poppler).
`renderSlideImage()`, `extractSlideText()`, `buildTranscriptionMessageContent()`,
`cleanConversionArtifacts()`, and the slide cache functions are exported so the
eval framework's transcription task sends the exact same call
production does for any model it tests.

### lib/unit-discovery.ts

File resolution: find PDFs and markdown for a given unit ID.

### lib/script-runner.ts

Shared process helpers: `runScript()`, `runScriptAsync()`, `promptUser()`.

### lib/db-queries.ts

Supabase client init, paginated fetch, distribution analysis. `createScriptSupabase()` is the entry point most write-capable scripts use; it calls `assertSupabaseTarget()` before returning a client.

### lib/units-db.ts

`fetchUnitsFromDb()` reads the `units` table (id, title, label, description, topics, sort_order, source_file_stem) straight into the `Unit` type, keeping the DB's own snake_case field names rather than mapping to camelCase.

### lib/supabase-target.ts

Resolves the Supabase project ref from `NEXT_PUBLIC_SUPABASE_URL` and decides
whether a write-capable call may proceed. See "Supabase target guard" below.

### lib/git-state.ts

Git state capture for provenance recording.

### lib/pipeline-config.ts

Re-exports `MODELS` from `@adaptive/shared/models` for pipeline commands, plus type classifications (`STRUCTURED_TYPES`, `TYPED_TYPES`), `getModelForType()`, and cost/grouping constants (`COST_PER_API_CALL`, `AUDIT_GROUP_SIZE`, `VALIDATION_GROUP_SIZE`).

### lib/topics.ts

Topic name normalization, similarity detection, deduplication, and the `--map-existing`
topic-to-heading mapping prompt builder (`buildMapExistingPrompt`) and response parser
(`parseMapExistingResponse`), shared between `content-suggest-topics.ts`'s repair mode and the eval
framework's `mapping` task.

### lib/learning-materials.ts

Heading validation (`findHeadingMismatches`, `collapseNestedHeadings`, slide-marker parsing via
`assertValidSlideMarkers`) and topic content loading (`loadUnitMaterials`, `extractTopicContent`,
`buildAuditMaterialsBlock`), shared by `content-suggest-topics.ts`, `questions-generate.ts`,
`content-extract-resources.ts`, and `questions-audit.ts`'s heading preflight checks.

### lib/mistral-audit.ts

Shared logic between `questions-audit.ts`'s Mistral synchronous audit loop and its `--llm-batch` /
`--llm-batch-resume` state machine: prompt construction, result parsing, the `llm_batch_jobs`
bookkeeping store, and the `quality_status`/`audit_metadata` write-db logic.
`callMistralAuditGroup()` and `renderedMistralAuditSystemPrompt()` take the model and settings as
arguments, so `eval-run.ts` reuses the same call shape production auditing does.

### lib/rate-limit-delay.ts

Inter-group pacing delay for `questions-audit.ts`'s synchronous Mistral loop: `nextInterGroupDelay()`
doubles the wait on a 429 (capped at 10s) and halves it after a group succeeds (floored at 1s).
This is separate from the per-attempt retry backoff for a single rate-limited request.

### lib/eval/

The evaluation framework's library, behind the `eval-*` commands: `db.ts` (the `EvalStore`
interface over `eval_sets`/`eval_items`/`eval_runs`/`eval_results`), `set-builder.ts` (stratified
sampling and item snapshots for `eval-set-create`, including `buildMappingItems`'s one-item-per-topic
mapping-task sets with reference set at creation from the unit's current headings, and
`categorizeTranscriptionSlides`/`drawTranscriptionSample`/`buildTranscriptionItems` for the
transcription task's three-category slide sample), `grading-seed.ts`
(deterministic typo/missing_accent generation for `eval-seed-grading`), `runner.ts` (interleaved-block
scheduling, `planAuditGroupCalls`' `--group-size`-aware audit sub-grouping, the grading
label-to-expected-outcome mapping, and the audit/grading per-task summary builders),
`mapping-scoring.ts` (heading normalization, per-topic heading-set F1, deterministic resolved/
unresolved/nested-duplicate checks, and the mapping task's run summary), `transcription-scoring.ts`
(transcript normalization, Levenshtein-based edit-distance scoring, markdown table-shape counting,
no-content marker detection, and the transcription task's run summary), `transcription-review.ts` (the
directory-based reference export/import helpers for transcription, one `<slide>.md` file per item instead
of a CSV row), `scoring.ts` (paired comparison, McNemar's exact test, and non-inferiority verdicts
for the binary tasks; the continuous-metric analogue (`meanAndCi95`, `signTestPValue`,
`pairedMappingComparison`, `mappingNoiseFloor`) for mapping's F1 and transcription's score metrics),
`sampling.ts` (seeded stratified sampling and shuffling, shared by
`eval-set-create`'s sampling and `eval-run --shuffle-groups`), `tolerances.ts`
(per-task tolerances, budget caps, and group-size-aware cost projection), `csv.ts` (the RFC 4180
reader/writer behind `eval-review-export` and `eval-review-import`'s `.csv` fallback), `workbook.ts`
(the `exceljs`-backed `.xlsx` writer/reader behind the same two commands' default format: headers,
description row, freeze panes, hidden columns, dropdown validation, and sheet protection),
`review-export.ts` (the audit/grading column layouts and the seeded row shuffling/grouping,
including grading's per-question `question_group` grouping and the multiple-choice `answer_key`
option-number prefix, shared by both output formats), `review-import.ts` (pure row validation and
reference-shape construction for `eval-review-import`, format-agnostic once a sheet's rows are parsed into
objects), `paths.ts` (`EVAL_REPORTS_DIR`, the default report/reference output location outside the
tracked tree, and `guardTrackedTreeWrite()`, which every write-capable command calls before its
first write to refuse a resolved output path inside the tracked pipeline package), `decided-by.ts`
(`resolveDecidedBy()`, shared by `eval-compare --decide` and `eval-finding` to resolve `--decided-by`
or `EVAL_DECIDED_BY` before either command writes an `eval_findings` row), `judge.ts` (the judge
prompt and its hash, the verdict shape and parser, the position-swap combination rule, and the
per-call message builder behind `eval-judge`), and `rescore.ts` (`eval-rescore`'s target resolution
for `--run`/`--set`/`--experiment` and its float-tolerant score comparison).

### lib/eval/compare/

`eval-compare`'s pure comparison and report-rendering logic, one module per task shape, none of
which makes a Supabase or model call: `shared.ts` (pairing a run's results by item, a run's own
cost/latency profile, the noise-floor section every task's report renders the same way, and the
provider-pin check run against every task's runs up front), `audit-grading.ts` (the audit and
grading tasks' paired agreement-with-reference outcomes and markdown report, including audit's
per-criterion non-inferiority verdict and its reference-free stability/agreement fallback),
`mapping.ts` (the mapping task's mean-F1 report, always reference-backed since mapping's reference
is set at `eval-set-create` time), and `transcription.ts` (the transcription task's mean-score
report and its reference-free agreement-with-baseline fallback for a set whose reference hasn't
been reviewed yet).

### lib/eval/tasks/

The `eval-run` side of each task: how its items are grouped into calls, how one planned call runs
against the production prompt/parser, and how a variant's outcomes are summarized once it
finishes. `types.ts` declares the `EvalTaskDefinition` contract every task module implements;
`registry.ts` looks one up by task name for `eval-run.ts`'s `main()` to dispatch through instead of
branching on `options.task` itself; `shared.ts` holds the retry policy and small helpers every task
uses. `audit.ts`, `grading.ts`, `mapping.ts`, and `transcription.ts` are the four task
implementations, one file per task.

### lib/sonnet-audit.ts

`questions-audit.ts`'s Sonnet auditor equivalent of `lib/mistral-audit.ts`'s write-db logic: the
4-criteria result shape and the `quality_status`/`audit_metadata` write, with no remediation.

### lib/streaming-audit.ts

The per-group loop both auditors share: audits one group of questions, applies that group's
results to the database immediately when a writer is supplied, and stops after the in-flight group
once told to. This is the mechanism behind `--write-db`'s streaming writes and SIGINT handling.

### lib/sigint.ts

`installSigintFlag()` sets a flag on SIGINT instead of exiting immediately, so `streaming-audit.ts`'s
loop (and other long-running commands) can finish the unit of work already in flight before stopping.

### lib/llm-batch.ts

OpenRouter batch API client: `submitBatch()` and `pollUntilDone()`. Used by `lib/mistral-audit.ts` to
submit and poll audit batch jobs; shares request-body construction with `@adaptive/shared/llm`'s
synchronous `callLlm()`.

### lib/writing-type-inference.ts

Pattern-based writing subtype inference from question text.

### lib/structural-validation.ts

Structural checks applied to generated questions before they reach Stage 2 validation: type filtering, blank-count validation, JSON parsing.

### lib/fs-utils.ts

`ensureDirFor(filePath)` creates a `--output`/`--report` path's parent directory before writing to it, most commonly `content/exports/`, which is gitignored and absent on a fresh clone.

### lib/usage-tracking.ts

Aggregates `LlmUsage` across a run's calls (`recordCall`, `addUsageTotals`) and formats the one-line
summary ("Usage: N calls, X prompt / Y completion tokens, $Z") every command prints once it has made
at least one LLM call.

### lib/dispatch/

Internals of the `pipeline` dispatcher. See "The `pipeline` dispatcher" above.

### prompts/

Prompt templates for PDF conversion, audit criteria, and topic extraction.

---

## Environment Requirements

All scripts require `.env.local` with:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
OPENROUTER_API_KEY=...

# Course branding — read by packages/shared/src/course.ts and interpolated into every
# generation/audit prompt (falls back to "French II" if unset):
COURSE_NAME=...
COURSE_TITLE=...

# For write operations (bypasses RLS):
SUPABASE_SECRET_KEY=...

# For write operations, confirms which project is being written to:
EXPECTED_SUPABASE_REF=...
```

See `.env.local.example` at the repo root for the full set of variables the app and scripts read.

---

## Supabase target guard

Every script that can write to the database resolves its Supabase target through
`createScriptSupabase()` (`apps/pipeline/src/lib/db-queries.ts`), which calls
`assertSupabaseTarget()` (`apps/pipeline/src/lib/supabase-target.ts`) before doing anything else.

- **Read-only calls** (no `--write-db`, or a script that never writes) print the
  resolved target, the project ref parsed out of `NEXT_PUBLIC_SUPABASE_URL`, and
  continue. No confirmation required.
- **Write-capable calls** additionally require one of:
  - `EXPECTED_SUPABASE_REF` in the environment matches the resolved ref, or
  - the script was invoked with `--yes-production`.

  If neither holds, the script prints the mismatch and exits before touching the
  database. This closes the gap where `dotenv.config()` silently keeps whatever
  `.env.local` currently points at: exporting `.env.test.local` into the shell by
  hand, and forgetting to, both look identical until a write actually lands
  somewhere unexpected.

Set `EXPECTED_SUPABASE_REF` only in the environment file for the database you write to
routinely, normally the test project's `.env.test.local`, exported into the shell. Leave it
out of the production environment so that every production write needs an explicit
`--yes-production`. A `--yes-production` run whose target differs from a set
`EXPECTED_SUPABASE_REF` still proceeds, and prints a warning naming both.

`db-check-connection.ts` calls `assertSupabaseTarget({ write: true })` directly,
since it always inserts and deletes test rows and doesn't go through
`createScriptSupabase()`.

---

## Common Workflows

```bash
# Test database connection
pipeline db-check-connection

# Full pipeline for one unit
pipeline pipeline-run unit-4 --write-db --audit

# Generate questions only (no PDF conversion)
pipeline questions-generate --unit unit-2 --write-db

# Audit pending questions with Mistral
pipeline questions-audit --pending-only --write-db

# Export questions for inspection
pipeline db-export-questions --output /tmp/questions.json

# Analyze distribution and plan generation
pipeline questions-plan --analyze-only

# Dry run to preview
pipeline pipeline-run unit-4 --write-db --audit --dry-run
```

(Guided workflows, the multi-step, named sequences like "Ingest a new unit", are a different thing
from this section's one-off command examples; see "Guided workflows" above.)
