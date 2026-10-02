# apps/pipeline

For a task-oriented walkthrough (ingesting a new unit, re-running generation, auditing, learning
resources, troubleshooting) see
[`docs/cli-guide-content-ingestion-and-question-pipeline.md`](../../docs/cli-guide-content-ingestion-and-question-pipeline.md).
This README is the command reference: what each command does and the behavior its `--help` screen
cannot carry. For flags, run `npx --no -- pipeline <command> --help`.

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
pipeline questions-generate --unit unit-2 --write-db          # bare `pipeline`, once it is on PATH
npx --no -- pipeline questions-generate --unit unit-2 --write-db      # npx, from the repo root; no PATH setup needed
npx tsx apps/pipeline/src/commands/questions-generate.ts --unit unit-2 --write-db  # the direct long form
```

The first two run through the `pipeline` dispatcher below; the third runs the script directly. All
three behave identically: same flags, same stdout and stderr, same exit code.

Run the npx form from inside this repo, as `npx --no -- pipeline`. Outside the repo, a plain
`npx pipeline` falls back to downloading and running an unrelated public npm package named
`pipeline`; `--no` makes npx stop instead, and `--` keeps npx from reading the command's options as
its own. To use bare `pipeline` from any folder, run `npm link` once in `apps/pipeline`.

---

## The `pipeline` dispatcher

`pipeline` (`bin/pipeline.ts`, the package's npm `bin` entry, plus `src/lib/dispatch/`) is a thin
frontend over the commands in `src/commands/`. It does not reimplement how a command parses its
flags or talks to Supabase. It discovers commands, runs one as a child process with the same argv
and exit code as calling it directly, and adds three things no individual command has: a grouped
command list, shell tab completion, and an interactive picker.

### Command discovery

The command list is not hand-maintained. `pipeline` scans `src/commands/` for
top-level `.ts` files matching `<area>-<action>[-<object>].ts` (the five areas in the table above).
A direct run (`pipeline <command> ...`) only checks the name against that list. `--help`, shell
completion, and guided mode also import each file to read its exported `cli` (the `defineCli()` result: name, description, and
option specs). Importing is safe because every command runs its `main()` only when executed directly
(`runIfMain`) and loads no environment file at import. `db-check-connection.ts`, the one command
without a `defineCli()` call, exports a `commandMeta` with its name and description instead. A new
command file that follows the naming convention appears in `pipeline --help`, completion, and guided
mode with no other changes. A file that fails to import is listed with a "Failed to load" line in
place of its description, and the other commands are unaffected.

`pipeline --help` lists every discovered command, grouped by area. A typo gets a nearest-match
suggestion (edit distance against every discovered command name) instead of a bare parser error:

```
$ pipeline questons-generate
Unknown command: 'questons-generate'. Did you mean 'questions-generate'?
Run `pipeline --help` (or `pipeline` at a TTY) to see all commands.
```

### Shell tab completion

```bash
pipeline completion zsh    # print a zsh completion script
pipeline completion bash   # print a bash completion script
pipeline completion        # print install instructions (no script)
```

The generated script completes command names (with descriptions), each command's own flags (with
their help text), fixed value lists for choice flags (`--difficulty`, `--type`, `--writing-type`,
`--columns`, ...), and unit ids for `--unit`, derived from filenames in `content/pdf/` and read
fresh every time the completion script runs, so it reflects whatever is on disk without a network
call.

There are two ways to install it. zsh supports both; bash supports only (a).

**(a) Always current.** Add this line to `~/.zshrc`, *after* the line that calls `compinit` (usually
`autoload -U compinit && compinit`, near the top of the file):

```zsh
source <(pipeline completion zsh)
```

Then reload with `exec zsh` (or open a new terminal tab). The completion function is regenerated
from whatever is on disk on every new shell, so it is never stale, at the cost of importing every
command module at shell start. For bash, add `source <(pipeline completion bash)` to `~/.bashrc`
instead.

**(b) Faster shell start, manual refresh.** Write the script once to a file on `fpath`, *before* the
`compinit` line in `~/.zshrc` (autoload needs the file in place first):

```zsh
# ~/.zshrc, before compinit:
fpath=(~/.zfunc $fpath)
autoload -U compinit && compinit
```

```bash
mkdir -p ~/.zfunc
pipeline completion zsh > ~/.zfunc/_pipeline
```

Re-run the `pipeline completion zsh > ~/.zfunc/_pipeline` line after adding a command, adding a PDF,
or pulling changes. This mode does not regenerate itself.

Either mode needs `pipeline` on PATH, which `npm link` inside `apps/pipeline/` provides.
`npx --no -- pipeline` always works from the repo root without any setup.

### Guided mode

Running `pipeline` with no arguments, at an interactive terminal, outside CI, enters guided mode:
pick a command (grouped by area, same as `--help`) or a named workflow (below), then answer its
options one at a time: choices as select lists, booleans as yes/no, numbers validated against their
`min`, required fields enforced, optional ones skippable. A command that can write to the database
shows the resolved Supabase target before asking to confirm the write. Before running anything,
guided mode prints the exact equivalent direct command and asks to confirm.

Guided mode never changes how a command behaves when run directly. It constructs the same argv the
command's own `defineCli()` would accept. Outside a TTY, in CI, or with any argument given,
`pipeline` never enters guided mode and prints `--help` instead (which is why `pipeline < /dev/null`
does not hang in CI).

### Guided workflows

Guided mode also offers named, multi-step workflows, declared in `src/lib/dispatch/workflows.ts`.
Each step prints the direct command it is about to run, asks to continue, and stops the workflow on a
non-zero exit code.

- **Ingest a new unit**: converts the PDF(s), extracts and reviews topics and generates questions
  (through `pipeline-run --review-topics --write-db`, so a brand-new unit's topics are upserted into
  the `units` table by the process that extracted them), then submits a Mistral batch audit scoped to
  the batch this run created (`questions-audit --llm-batch --batch-id <id>`). Batch turnaround is set
  by OpenRouter and can be hours. The workflow prints the exact resume command once the job is
  looked up from `llm_batch_jobs`.
- **Resume a batch audit**: lists jobs from `llm_batch_jobs` that have not been applied yet
  (`applied_at IS NULL`), and resumes the one you pick.

---

## Shared CLI conventions

Every command's flags are declared through `src/lib/options/define-cli.ts`, a shared declarative
option parser with the same baseline behavior everywhere:

- Value flags accept `--flag value` or `--flag=value`. Switches such as `--write-db` are written bare; `--write-db=false` is an error, and a value flag with no value is an error.
- An unrecognized flag fails immediately with a usage hint instead of being ignored.
- `--help` / `-h` prints full usage, generated from the same schema the command runs against.

Two option groups (`src/lib/options/groups.ts`) are shared and appear in every command's help:

- **Database target** (any command that can write): `--write-db` writes results to the database (it
  uses the secret key and bypasses RLS), and `--yes-production` confirms a write-capable run against
  an unexpected Supabase target. See "Supabase target guard" below.
- **Logging**: `--verbose` shows debug-level tracing and `--quiet` shows only warnings and errors.
  `--verbose` wins if both are passed. The pipeline logger (`src/lib/logger.ts`) is separate from the
  web app's, and has no production or preview gating since pipeline commands never run deployed.

A write-capable command writes only when `--write-db` is given.

**Paths.** Directory anchors (`content/pdf/`, `content/markdown/`, `content/exports/`, prompts) are
resolved from the package's own location, so they work from the repo root or from `apps/pipeline`.
A path you pass as a flag value (`--output`, `--from-proposal`, `--markdown`, `--pdf`, `--report`,
`--out`) is read or written relative to the shell's working directory. Generated files such as
`heading-repair-<unit>.{json,md}` and conversion reports always land under
`apps/pipeline/content/`, so from the repo root name them as `apps/pipeline/content/...`.

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      pipeline-run.ts                            │
│  (orchestrator, runs the full pipeline for a unit)              │
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
        (quality gate, Stage 3, --auditor mistral|sonnet)
                  │
                  ▼
            Supabase DB
            (questions table)
```

See [`docs/pipeline-architecture.md`](../../docs/pipeline-architecture.md) for the stages, gate
criteria, and model assignments.

---

## Command Reference

### pipeline-run

Full pipeline orchestrator: PDF to Markdown to Topics to Questions to Audit.

```bash
pipeline pipeline-run <unit-id> [options]     # or --unit <unit-id>, or --all for every known unit
```

`--audit` runs the quality audit after generation and requires `--write-db`. `--skip-convert`,
`--skip-topics`, and `--skip-resources` skip a step, `--force-convert` reconverts even if markdown
exists, `--convert-only` stops after PDF conversion, and `--markdown-file <path>` bypasses PDF
conversion. `--review-topics` runs an interactive topic review for a domain expert, and
`--exclusion-pass <model>` sets the teaching-content classifier model that gates each slide before
its transcription call (default `MODELS.slideContentClassifier` in `packages/shared`; `off`
transcribes every slide). Unit files are matched by name; see the CLI guide for how.

**PDF conversion.** Every PDF page is one slide. Each is rendered as an image and transcribed by a
vision model (`MODELS.pdfConversion`), with the slide's `pdftotext` text layer as an unreliable
hint: course slides are often screenshots whose teaching text lives in the image. Per-slide output
is cached under `content/exports/pdf-slide-cache/`, keyed on the slide image, text layer, prompt, and
model, so reruns do not re-pay for unchanged slides. A slide that fails twice fails the whole
conversion with its slide number. Output slides are joined with `<!-- slide N -->` markers. A slide
the model judges to have no teaching content is reported as skipped. A slide with a real text layer
(5 or more qualifying words) is flagged when the output covers less than 80% of it; a slide whose
text layer is only a title or label is excluded from that check. Each PDF gets a
`<name>.conversion-report.json` listing flagged slides, skipped slides (with a text-layer preview),
and slides whose text layer was thin enough to be image-dominated. Conversion needs `pdftotext`,
`pdftoppm`, and `pdfinfo` from poppler on PATH.

### content-suggest-topics

Extracts teachable topics from a markdown learning material and stores them in the `units` table.
Each topic's `headings` (`units.topics[].headings`, typed `TopicHeadingRef[]` in
`@adaptive/shared/types`) are validated against the document's real `#`-headings before anything is
written. A heading that does not match gets one corrective retry against the model, then fails the
whole run loudly instead of silently storing an unverifiable mapping.

Heading text alone is not unique in a real document: "Warm Up", "Exercices", and similar section
titles repeat across a unit. A stored heading is either a bare string, valid only when that exact
text is unique in the document, or a `{ heading, slide }` pair that pins the occurrence by the
`<!-- slide N -->` in effect at that heading. Extraction and `--map-existing` always ask the model
for a slide, and simplify the result to a bare string wherever the text turns out to be unique.

A topic's stored `headings` are also collapsed against each other: an exact duplicate, or a heading
whose resolved section already contains another listed heading's occurrence (a `##` parent and one
of its own `###` children assigned to the same topic), is dropped so the same content is never
counted twice. This runs wherever headings are read and wherever a final list is stored or written
to a proposal.

The topic-to-heading review output ends with a **WARNINGS** section of non-blocking, deterministic
hints: identical content across topics, one topic's content sitting entirely inside another's, a
topic under a small character threshold, a single section linked by three or more topics, and a
topic whose linked headings share no meaningful word with its name. None fail the run; a unit can
legitimately have topics that share a practice slide or word things differently than their headings.

```bash
pipeline content-suggest-topics <markdown-file> <unit-id>
pipeline content-suggest-topics <markdown-file> <unit-id> --map-existing [--write-db]
pipeline content-suggest-topics <markdown-file> <unit-id> --map-existing --from-proposal <path> [--write-db]
pipeline content-suggest-topics --consolidate
```

`--consolidate` runs cross-unit topic consolidation instead of extracting from one file.

`--map-existing` repairs headings for `<unit-id>`'s existing topic names without re-extracting the
names, for a unit whose names are already fixed (for example, questions exist against them) but whose
headings need rebuilding. It writes a proposal (per-topic headings, section count, character count,
and slide range) to `apps/pipeline/content/exports/heading-repair-<unit-id>.{json,md}`; `--write-db`
also writes the repaired headings to the `units` table.

`--from-proposal <path>` applies a proposal file (typically the previous run's output, hand-edited to
fix mapping mistakes) instead of calling the model. It validates every heading the same way, prints
the same review table, and writes only `headings`: topic names and every other unit field are
untouched. `--write-db` applies only with `--map-existing`, and the command has no `--verbose` or
`--quiet`.

**Any existing unit must be mapped with `--map-existing` before its topics can generate anything.**
Headings stored before exact-heading matching (word tokens such as `["bilan:", "past", "tense"]`
rather than verbatim heading text) never resolve under the current rule. `questions-generate` and
`content-extract-resources` check this before doing anything else and exit with an error naming the
unit and every mismatched heading.

### content-extract-resources

Extracts learning resources (YouTube URLs and others) from markdown into `learning_resources`.
`--unit` limits it to one unit, `--force` re-extracts even if resources exist, and without
`--write-db` it previews. Before scanning any unit it validates every topic's stored `headings`
against that unit's current markdown (see `content-suggest-topics`) and exits non-zero, naming the
unit and every mismatched heading, if any do not resolve. A topic with no stored headings is
unaffected: it uses the name-substring fallback.

### questions-generate

Stage 1 (generation) and Stage 2 (validation). The default routing is hybrid: the smaller model
for beginner and intermediate MCQ and true-false, the larger one for typed answers and everything at
advanced difficulty. `--model <slug>` overrides the model for every type and disables hybrid routing;
`--generation-model-structured`, `--generation-model-typed`, and `--validation-model` override one
stage. `--skip-validation` skips Stage 2 (faster, but no acceptable-variation generation).

Before generating anything, it validates every topic's stored `headings` against the unit's current
markdown, for every unit the run would touch. This catches a unit whose headings predate exact-heading
matching, instead of letting the run "succeed" having generated zero questions.

The prompt (`prompts/questions-generate.md`) uses a topic's extracted content to set scope, not
correctness: it says which vocabulary, grammar, and cultural topics to test, but the French and the
facts in every question must be correct even when the material contains an error. Without `--count`,
each topic and difficulty gets a question count computed from its content length (see "Question
count" in the architecture doc), and the model is asked for "up to" that many; returning fewer is
expected for thin topics and is not retried.

### questions-plan

Analyzes the current question distribution against the target and plans targeted generation.
`--analyze-only` shows the analysis and stops, `--execute` runs the plan after an interactive
confirmation, and `--target-writing <n>` sets the target percentage of writing questions. It has no
`--write-db`; `--execute` prompts before spawning generation.

### questions-audit

Stage 3 quality audit. `--auditor mistral` (the default) applies a 6-criteria gate plus remediation
(difficulty relabeling, variation removal). `--auditor sonnet` applies a narrower 4-criteria gate
(`answer_correct`, `grammar_correct`, `no_hallucination`, `question_coherent`) with no remediation,
for comparison runs against the Mistral auditor. With `--write-db`, both auditors write each group's
results to the database as soon as that group's call completes, so an interrupted run (crash,
Ctrl-C) keeps what it already wrote.

Every question is audited alongside an excerpt of the course material its topic was generated from,
and a two-gate preflight runs before any model call. Both are described in "Audit grounding and
gate scope" and "Preflight" in the architecture doc. `--allow-missing-material` skips the second
preflight gate.

`--pending-only` limits a run to never-audited questions and picks up where an interrupted run
stopped. Omitting it re-audits a batch's `active` and `flagged` questions too and writes whichever
verdict the new run reaches in either direction.

`--llm-batch` submits the audit as an OpenRouter batch job instead of calling the sync endpoint per
group, and records the job in `llm_batch_jobs`. `--llm-batch-resume <job-id>` polls it; add
`--write-db` to apply results once the batch completes. A whole-batch pre-execution failure falls
back to the sync endpoint automatically when resumed with `--write-db`. Both flags are Mistral-only
and are rejected with `--auditor sonnet`. See "Batch Audits" in the architecture doc for the
bookkeeping and apply-once semantics. The default, with neither flag, audits synchronously.

### db-export-questions

Exports the questions table to JSON, for inspection, archival, or cross-model audit.
`--columns minimal` (default) or `full`, the usual question filters, and `--output <path>` (default
`content/exports/corpus-export.json` relative to the working directory).

### db-seed-study-code-words

Seeds `study_code_source_words` with the adjective and animal word pools used to generate anonymous
study codes. `--count <n>` sets how many of each category to sample. A dry run unless `--write-db`
is given. The app cannot issue study codes until this has run.

### db-prune-study-codes

Deletes study codes with no activity for `--inactive-days <n>` days (default 90). A code's activity
is its last quiz submission, or its creation if it never submitted one. `--no-quizzes-only` limits
the prune to codes with no `quiz_history` rows. Superuser codes are never pruned. Deleting a code cascades to its quiz history,
question results and Leitner state. A dry run unless `--write-db`, which prints how many codes
would go and how many of them have quiz history. The admin stats show the count of inactive codes.

### db-check-connection

Checks that the service key (`SUPABASE_SECRET_KEY`) can read each core table and view, and prints a
row count or the error for each. It takes no options and writes nothing, so it needs no write
confirmation. A missing secret key is an error.

---

## Evaluation commands

The `eval-` commands test whether a different model, provider, or setting does as well as what
production uses on the audit, grading, mapping, or transcription task. They run against a frozen
sample, through the same prompt builder and parser production calls. See
[`docs/pipeline-architecture.md`](../../docs/pipeline-architecture.md#evaluation-framework) for the
tables and concepts, and
[the CLI guide](../../docs/cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models)
for the workflow.

`eval-compare` writes its markdown report outside the tracked tree, because reports can carry course
question and answer text. The default report folder is `.private/eval/reports/` (gitignored, local
to your checkout); set `EVAL_REPORTS_DIR` to use another. Every write-capable eval command refuses
an output path that resolves inside the tracked tree, including `eval-review-export`'s `--out`.

### eval-experiment-create

Validates and creates (or updates) one `eval_experiments` row: the named question an evaluation is
testing, before any run is attributed to it. Dry run by default, printing the row or patch it would
write plus which `eval_models_current` row each declared variant's `model_slug` resolved to.

- `--tasks` takes the task vocabulary in `src/lib/eval/types.ts`. `generation` and `validation` are
  accepted with a warning, since no runner exists for either.
- `--variants` is a path to a JSON array of `{label, model_slug, role, settings?, baseline_from?}`.
  `label` is non-empty and unique within the file. `model_slug` must resolve against
  `eval_models_current`, unless it is `'*'` or `null`, which span several models and match no run by
  design. `role` is one of `baseline`, `candidate`, `exclusion_pass`, `step_down`, `cross_vendor`,
  `specialist`, `prompt_variant`, or `successor`. `settings` is limited to the repeat-identity keys
  `eval-run` writes (`REPEAT_IDENTITY_SETTINGS_KEYS` in `eval-run.ts`), each checked against the
  shape `eval-run` writes for it. `repeats` is refused: set it with `eval-run --repeat`.
  `baseline_from`, valid on a `baseline` only, names another experiment whose runs the declaration
  draws on; the experiment must exist and not be this one.
- `--decision-rule` is a path to a JSON object limited to the keys `resolveTolerance()`
  (`tolerances.ts`) knows: `tolerance`, `precisionTolerance`, `maxSlideDrop` (each a number between
  0 and 1), and `description`. An unrecognized key is refused.
- `--depends-on` is a comma-separated list of experiment slugs, each checked to exist.
- `--status` accepts only `proposed` or `running`; `decided`, `deferred`, and `superseded` come only
  from `eval-compare --decide`.
- `--update <slug>` replaces any subset of `--question`, `--variants`, `--decision-rule`,
  `--depends-on`, and `--notes` on an existing experiment through the same validation. `--slug`,
  `--tasks`, and `--status` cannot change this way. An update that would orphan runs is refused: it
  may not drop a label that has runs, or change a label's declaration so it no longer matches runs it
  matches today, and the refusal names the label and the runs.

### eval-set-create

Samples a frozen, hashed item set (`eval_sets`/`eval_items`) for the audit, grading, mapping, or
transcription task. Dry run by default.

- **Audit** stratifies a sample of questions (`--strata`, `--size`, `--seed`). `--balance-status`
  oversamples flagged questions to half the sample, and `--pool-ids`/`--pool-size` add extra items
  after the stratified core.
- **Grading** builds one item per question and label class (`--per-question`), each with an empty
  `submitted_answer` placeholder. `--size` caps the number of questions before label classes
  (default: all).
- **Mapping** creates one item per topic of `--unit`, with reference set immediately from the unit's
  own validated headings. It refuses if any topic has no headings; repair it first with
  `content-suggest-topics --map-existing`.
- **Transcription** draws `--per-category` slides from each of three categories (image-dominated and
  text, from `--report`'s own categorization, plus a "mixed" category derived from text-layer
  length). It refuses if a category has fewer slides than requested. Reference stays pending until
  reviewed.

### eval-seed-grading

Fills a grading set's `submitted_answer` placeholders. `typo` and `missing_accent` are computed
deterministically from the correct answer; the other four label classes go through one model call
per question. Every item stays `reference_status: 'pending'` until reviewed; an item with no valid
deterministic answer is marked `rejected` with a note. Dry run by default (pending items by label
class and the projected model cost, no model call); `--write-db` calls the model and persists.

### eval-run

Runs one or more model variants against a frozen set through the production prompt builder and
parser. Audit, grading, and transcription variants are interleaved in blocks of 25 items. Audit
items are grouped by `--group-size` (default 1, matching production). `--shuffle-groups <seed>`
permutes item order before grouping, so a repeat can be regrouped deterministically. Mapping sends
every item in one call per variant per repeat, so `--group-size` and `--shuffle-groups` do not apply.

Each task defaults to production's own call settings (audit: temperature 0.1, JSON mode, pinned to
Mistral; grading: `GRADING_CALL_SETTINGS`; mapping and transcription: no temperature, JSON mode, or
provider pin) unless `--temperature` or `--provider` override them, so an unlabeled baseline
reproduces what production sends. A `--provider` value is lowercased before it is recorded.

**Budget.** Each variant's cost is projected before it starts. `--max-cost` refuses to start any
variant projected above it, and a model with no listed price is refused unless `--allow-unpriced`.
The projection accounts for `--group-size`. A Mistral-family model is throttled to one request per
second.

**Registry and experiment.** Before anything runs, `--models` is resolved against
`eval_models_current` and `--experiment`, if given, against `eval_experiments`. A model with no
registry row, or an unresolvable experiment, refuses the whole invocation and prints what is missing.
A resolved run stamps `experiment_id` and `model_version_id` on its `eval_runs` row, and
`served_provider` on its results next to `served_model` (what OpenRouter served, as distinct from
what `--provider` requested).

**Transcription.** `--render-dpi <n>` (72 to 400, default 120) sets the slide render resolution;
production and `eval-judge` always render at 120, so a changed value measures the model's
sensitivity to resolution. `--exclusion-pass <model>` gates each slide through a teaching-content
classifier before the transcription call: a slide it judges not to teach the course language gets
the no-content marker with no transcription call. The classifier honors `--provider` by default, and
`--exclusion-provider <tag>` overrides that. The gate's model, provider, and verdict are recorded on
`settings.exclusionPass` and each result's `deterministic_checks`; the cost projection adds one
classifier call per slide.

**Sampling constraints.** `temperature` is dropped for a model that `MODEL_CONSTRAINTS`
(`@adaptive/shared/models`) flags as requiring its own fixed default, and a task that would send
`reasoning: { enabled: false }` sends the lowest registered effort tier instead when the model's
registry row says reasoning is mandatory. An explicit `--reasoning` is never adjusted and is left to
fail if the model rejects it. The values sent are recorded as
`settings.effectiveTemperature` and `settings.effectiveReasoning` next to the intended ones.

**Results.** Every finished run's `summary` carries a top-level
`primary_metric: {name, value, direction}` that the comparison views select across tasks, and the
same write stamps `scored_at` and `scoring_review_round_id` through `stampSummary`
(`src/lib/eval/summary-stamp.ts`, shared with `eval-rescore`). Every variant's row reaches a
terminal status before the process exits: `completed`; `failed`, with the message in
`summary.error`, when something outside per-item handling breaks the variant or every result row
carries an error; or `aborted` for every non-errored variant on SIGINT (the call in flight finishes
first). A row is never left `running`.

**Labels and repeats.** A run's `variant_label` is `<label>:<model slug>`, with no repeat suffix;
`repeat_index` carries that. `--label` defaults to the experiment slug, else the task name. With
`--experiment`, `repeat_index` is one more than the number of existing non-failed, non-aborted runs
on that experiment for the same set and model with the same prompt hash and caller-controlled
settings, so a repeat launched by hand later continues the count and a changed setting
(`--render-dpi`, `--temperature`, ...) starts its own count from 1. Without `--experiment`, it
restarts at 1 per invocation. Identity is keyed on what was requested, not what was sent: for
example `--reasoning off` and no `--reasoning` flag are different identities on a transcription run,
even though both send no reasoning. The normalization lives in `normalizeRepeatIdentitySettings` in
`eval-run.ts`.

### eval-rescore

Recomputes a completed run's per-item scores and `eval_runs.summary` from what is already stored,
with no model call. Use it when a run finished before its reference existed, or after a summary
field changes. Targets exactly one of `--run`, `--set` (every completed run on that set), or
`--experiment` (id or slug). A run that is not `completed`, whose set has no items, or that has no
results is skipped with a message. `status` and `finished_at` are never touched; `scored_at` and
`scoring_review_round_id` are refreshed. Dry run by default, printing each run's old and new
`primary_metric` and how many item scores would change.

### eval-compare

Paired comparison of candidate runs against a baseline on their shared, reference-approved items:
agreement, McNemar's exact test, a 95% confidence interval on the difference, the non-inferiority
verdict against a resolved tolerance, and the noise floor from any repeats of the same model among
the runs given. It always writes the markdown report; `--write-db` additionally persists the
comparison into each run's `eval_runs.summary.compare`. `--include-rejected-keys` includes grading
items whose question key the reviewer marked incorrect.

**Tolerance.** The verdict is judged against the candidate's own `eval_experiments` row, never the
baseline's, because a baseline is routinely reused across experiments. With `--candidate`, that run's
`experiment_id`; otherwise the one experiment every candidate in `--runs` shares. Candidates citing
more than one experiment with no `--candidate` are refused. The experiment's `decision_rule` can
override `tolerance`, `precisionTolerance`, or `maxSlideDrop`; otherwise the task default applies
(`TASK_TOLERANCES` in `src/lib/eval/tolerances.ts`). Any other key is ignored with a warning. The
report's "Tolerance:" line states which rule applied and where it came from.

**Confounds.** The report notes, per candidate, whether it shares `prompt_hash` with the baseline and
how the two compare on serving host, with a warning when either differs or is unknown. A run whose
results named a `served_provider` other than its own `provider_pin` is flagged, comparing normalized
forms so `--provider anthropic` is not flagged against OpenRouter's `Anthropic`.

**Report shapes.**

- Grading's verdict is the paired statistic directly.
- Audit's headline is a per-criterion verdict, each criterion checked against its own recall and
  precision tolerance, reading "All criteria pass" or naming the ones that failed. The pooled
  statistic across all six is informational only, labeled "correlated pairs", because pooling treats
  correlated criteria as independent. Audit reports also list items where the compared runs disagree,
  with each run's per-criterion verdict and the auditor's stored notes, capped at 60.
- Mapping and transcription use a continuous primary metric (per-topic heading-set F1, or
  `1 - normalized edit distance`), so each run gets a mean score with a 95% CI, cost, latency, and
  task-specific stats, plus the paired score difference against the baseline with the
  better/worse/tied split and an exact sign test. Mapping has no verdict. Transcription's verdict runs
  on words captured, with per-slide conditions: a candidate that falls too far below the baseline's
  word recall (content lost) or word precision (content added) on any slide scored in both runs is
  not non-inferior, regardless of the mean.
- With no approved reference items, the command does not exit. It reports stability and agreement
  instead (item-level verdict agreement, per-criterion flip counts and flag rates for audit, cost and
  latency, and the noise floor), headed "no reference: stability and agreement only; no accuracy
  verdict". A repeat's noise floor is labeled `identical-groups` or `different-groupings` from the
  repeats' recorded `--group-size` and `--shuffle-groups`: same-group disagreement is run-to-run
  noise, different-grouping disagreement is the audit's group-context sensitivity. Mapping's
  reference is set at creation, so it has no reference-free form.

**Deciding.** `--write-db` only ever persists the comparison. It never touches `eval_findings` or an
experiment's status. Recording a decision is a separate step: `--decide <adopt|reject|defer>` with a
required `--statement "<one line>"`, which also needs `--write-db` and a candidate run that carries an
`experiment_id`. With more than one candidate in `--runs`, `--candidate <run_id>` says which one.
`adopt` is refused unless the candidate's comparison produced a non-inferior verdict against a
reference; `reject` and `defer` need no verdict, and mapping, which never has one, supports only
those two. A decision writes one `eval_findings` row citing both runs and moves the experiment to
`decided` (adopt or reject) or `deferred`. Because `eval_findings` is append-only, a second decision
on the same baseline and candidate pair under the same experiment needs `--supersedes <finding_id>`.
`--decided-by <name>`, or else `EVAL_DECIDED_BY`, names the operator who recorded the row and is
required with `--decide`; the statement is where a ruling's actual origin is recorded.

### eval-finding

Records a plain observation as an `eval_findings` row: something worth writing down about the
evidence that is not an adopt, reject, or defer decision. `eval-compare --decide` is the only other
route into the table, and it always moves an experiment's status, which is wrong for a standalone
observation. `--experiment` and `--task` are optional. `--runs` and `--items` are the cited
evidence: each run must resolve, and each item must belong to the set of at least one cited run.
`--supersedes <finding_id>` names an earlier finding this one revises, and `--kind` accepts only
`observation`. `--decided-by <name>` or `EVAL_DECIDED_BY` is required with `--write-db`. Dry run by
default, printing the row it would insert. It never touches `eval_experiments`.

### eval-judge

A reference-free, paired judge comparison of two completed transcription runs on the same set, for
when scoring against a checked transcript is not the question (that reference was seeded from
production's own output, so a run compared through it is partly scored against that model's choices).
A third model sees the slide image, the PDF text-layer hint, and the two transcripts, and picks the
more complete and faithful one. Every shared item is judged twice with positions swapped; a run wins
only when it wins in both orders, and a split or a tie is a tie. The stored shape is described under
"Judge verdicts" in the architecture doc.

Dry run by default, printing the projected judge cost from the registry's list price against the
same budget cap `eval-run` uses; an unpriced judge model is refused unless `--allow-unpriced`.
`--write-db` calls the judge and appends an entry to each shared item's `eval_results.judge_verdict`
for both runs. Entries are never overwritten, so a pair can be judged again, by the same judge or
another. `repeat` is 0-based and counts earlier entries from the same judge model. Before calling the
judge the command prints how many entries the pair already holds under the current prompt hash, per
judge model, and which repeat index this run will take. A stored `judge_verdict` that is not a list
makes the command stop. Items that fail are skipped and listed at the end, and hold one fewer entry
for that judge model, so compare repeats by `repeat` and `judge_model`, not by position. The command
prints items judged, wins for each run, ties, the item keys of every non-tie, and projected versus
actual cost.

### eval-review-export

Exports a frozen set's items for a human reviewer to fill in reference. Audit and grading get a blind
reviewer sheet (an `.xlsx` workbook by default, or `.csv` with `--format csv`) with no
`quality_status`, `audit_metadata`, production verdict, `selection_pool` tag, or (for grading)
`label_class`. Row order is shuffled with a seed printed to the console (pass `--seed` to reproduce
it). Grading rows are grouped by source question (`question_group`, `Q1..Qn`), each group's answers
shuffled within it, and `ref` (1..N) numbered after that ordering. `--all-classes` includes
`typo`/`missing_accent` items, excluded by default. Transcription gets a directory instead: one
`<slide>.md` file per item, plus a `README.md` listing every slide and its category, prefilled with
`--from-run`'s output when given. Read-only.

The `.xlsx` workbook has one worksheet: row 1 is bold column headers and row 2 an italic
per-column description, both frozen. `item_id` and `difficulty` are hidden columns. The criterion,
`borderline`, `key_incorrect`, and `is_correct` columns carry dropdowns (`Pass`/`Fail`,
`TRUE`/`FALSE`, `Correct`/`Incorrect`). Text columns wrap, and the sheet is protected with every
context column locked, leaving only the input columns (rows 3..N) editable. A multiple-choice
`answer_key` is prefixed with the option's 1-based position in `options` so a reviewer can find it at
a glance; if no option matches, the key is left unprefixed and a warning names the item. The `.csv`
fallback carries the same columns, numbering, and row-2 descriptions without formatting.

Grading's `key_incorrect` and `key_note` columns (after `answer_key`) hold the reviewer's verdict on
the answer key itself, not the student's answer. They are editable only on each `question_group`'s
first row; the group's other rows have both cells locked, empty, and filled light gray.

### eval-review-import

Reads a reviewer's completed reference back and writes `eval_items.reference`. Audit and grading read
a sheet (`.xlsx` or `.csv`, detected by extension) from `eval-review-export`, skipping its row-2
description row; transcription reads a directory of `<slide>.md` files. `item_id` is the sole join
key. It validates everything before any write (item existence and uniqueness, well-formed cells or
non-empty files, and a required `reason` or non-empty transcript wherever one is needed) and refuses
to write anything if any of it fails. `--policy-labels` (grading only) also approves every
`typo`/`missing_accent` item without a sheet row. An item already `approved` is left alone unless
`--overwrite` is given. `--sheet` picks a worksheet from an `.xlsx` by exact name or prefix (the
export truncates tab names to 31 characters). Dry run by default; `--write-db` performs the writes,
then records one `eval_review_rounds` row for the set with `reviewed_item_count` set to the number of
items this run wrote.

A reference corrected outside this command (by hand, in the table editor) must still get an
`eval_review_rounds` row for its set. `metric_status` treats a review round newer than the one a run
was scored against as its own "reference changed" signal, independent of `reviewed_at`, so a hand
correction that skips the round is invisible to that check.

For grading, the key verdict is read once per `question_group`: `key_incorrect` checked on any row of
the group means the key is wrong, and blank or `FALSE` elsewhere in the group is normal. `key_note`
is required whenever the key is wrong, and disagreeing `key_note` text across a group's rows is a
validation error naming the group.

---

## Directory map

- `bin/pipeline.ts`: the `pipeline` dispatcher entry (the npm `bin` target).
- `src/commands/`: one file per command, named `<area>-<action>[-<object>].ts`.
- `src/lib/options/`: the declarative option parser (`define-cli.ts`) and shared flag groups
  (`groups.ts`).
- `src/lib/dispatch/`: dispatcher internals: discovery, completion, guided mode, workflows.
- `src/lib/eval/`: the evaluation framework's library behind the `eval-` commands. `compare/` holds
  the pure comparison and report rendering per task shape, and `tasks/` the `eval-run` side of each
  task (one module per task behind a registry).
- `src/lib/`: shared helpers. `paths.ts` anchors the content, exports, and prompts directories,
  `env.ts` loads the repo-root `.env.local` (called from inside a command's `main()`, never at module
  scope), `db-queries.ts` creates the Supabase client (`createScriptSupabase()` calls
  `assertSupabaseTarget()` first), and `learning-materials.ts` holds heading validation and topic
  content loading.
- `prompts/`: prompt templates for PDF conversion, generation, validation, audit, and topic
  extraction.
- `content/`: working files (`pdf/`, `markdown/`, `exports/`), gitignored. The course PDFs are not in
  the repository.

---

## Environment

Commands read the repo-root `.env.local` (copy `.env.local.example`).

| Variable | Needed for |
|----------|------------|
| `OPENROUTER_API_KEY` | Every model call |
| `NEXT_PUBLIC_SUPABASE_URL` | Every command that reads the database |
| `SUPABASE_SECRET_KEY` | Every command that reads or writes the database (the pipeline never uses the anon key); bypasses RLS |
| `EXPECTED_SUPABASE_REF` | Confirms which project a write targets; see below |
| `COURSE_NAME`, `COURSE_TITLE` | Course branding interpolated into every generation and audit prompt (read by `packages/shared/src/course.ts`) |
| `EVAL_DECIDED_BY` | Default for `--decided-by` on `eval-compare --decide` and `eval-finding` |
| `EVAL_REPORTS_DIR` | Output folder for `eval-compare` reports, instead of the default described above |

PDF conversion also needs poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) on PATH.

## Supabase target guard

Every command that can write resolves its Supabase target through `createScriptSupabase()`, which
prints the target and, for a write, requires `EXPECTED_SUPABASE_REF` to match it or `--yes-production`
to be passed. The full rule, with the reasoning and
the recommended per-environment setup, is in
[section 2 of the CLI guide](../../docs/cli-guide-content-ingestion-and-question-pipeline.md#2-safety-model).
