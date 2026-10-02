# Content pipeline: ingestion and question generation

A task-oriented walkthrough of `apps/pipeline` for a developer or someone running the pipeline who
has cloned this repo and wants to add a unit, generate questions for it, and get them audited into
production. For what each command does, see [`apps/pipeline/README.md`](../apps/pipeline/README.md);
for flags, run `npx --no -- pipeline <command> --help`. Commands in this guide run from the repo
root.

## Contents

1. [Setup](#1-setup)
2. [Safety model](#2-safety-model)
3. [Workflow: ingest a new unit](#3-workflow-ingest-a-new-unit)
4. [Workflow: re-run or extend generation for a unit](#4-workflow-re-run-or-extend-generation-for-a-unit)
5. [Workflow: audit and re-audit](#5-workflow-audit-and-re-audit)
6. [Workflow: learning resources](#6-workflow-learning-resources)
7. [Exports and utilities](#7-exports-and-utilities)
8. [Troubleshooting](#8-troubleshooting)
9. [End-to-end example: Unit 1 against the test database](#9-end-to-end-example-unit-1-against-the-test-database)
10. [Workflow: evaluating models](#10-workflow-evaluating-models)

---

## 1. Setup

```bash
npm install
cp .env.local.example .env.local
# fill in OPENROUTER_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SECRET_KEY, and (for the test database) EXPECTED_SUPABASE_REF
```

PDF conversion also needs poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) on PATH.

`npm install` at the repo root installs and links all three workspaces and the `pipeline` bin, so
`npx --no -- pipeline --help` works immediately from the repo root. Always use the `--no --` form:
outside the repo, a plain `npx pipeline` downloads an unrelated public package. The pipeline README
explains the three equivalent ways to run a command, `npm link` for a bare `pipeline`, and shell
completion. This guide shows the `pipeline <command>` form throughout.

`pipeline` with no arguments, at an interactive terminal and outside CI, starts **guided mode**: pick
a command or a named workflow, answer its options one at a time, see the equivalent direct command,
and confirm before it runs. It offers two multi-step workflows:

- **Ingest a new unit**: convert PDF(s), review extracted topics, generate questions, submit a
  Mistral batch audit. Section 3 walks through the same steps by hand.
- **Resume a batch audit**: lists pending jobs from `llm_batch_jobs` and resumes the one you pick.

Both workflows, and any guided command that writes to the database, check the target first and stop
before running anything unless the write is confirmed through `EXPECTED_SUPABASE_REF`. For the test
database, load `.env.test.local` into the terminal before starting (`set -a; source .env.test.local;
set +a`). Guided mode never passes `--yes-production`; production runs use the direct commands.

---

## 2. Safety model

Every pipeline command prints which Supabase project it is about to talk to, before doing anything
else:

```
[INFO] [supabase-target] Supabase target: abcdefghijklmnop (https://abcdefghijklmnop.supabase.co)
```

For a read-only call, that is all that happens. For a **write-capable call** (any command with
`--write-db`), the target must additionally be confirmed, by one of:

- `EXPECTED_SUPABASE_REF` in the environment matches the resolved project ref, or
- the command was invoked with `--yes-production`.

If neither holds, the command prints the mismatch and exits before touching the database. The guard
exists because dotenv does not override an already-exported shell variable, so loading `.env.local`
silently keeps whatever `.env.local` points at. Exporting `.env.test.local` by hand, and
forgetting to, look identical until a write lands somewhere unexpected.

In practice:

- Set `EXPECTED_SUPABASE_REF` only in `.env.test.local`, to the test project's ref (the subdomain in
  its `NEXT_PUBLIC_SUPABASE_URL`, for example `abcdefghijklmnop` from
  `https://abcdefghijklmnop.supabase.co`). Leave it unset in `.env.local` (production), so every
  production write needs an explicit `--yes-production`.
- For a routine run against the **test database**, export `.env.test.local` into the shell before
  running any pipeline command. `pipeline` loads only `.env.local` on its own:

  ```bash
  set -a; source .env.test.local; set +a
  pipeline questions-generate --unit unit-1 --write-db
  ```

- For a **production** write, pass `--yes-production` explicitly. A `--yes-production` run whose
  target differs from a set `EXPECTED_SUPABASE_REF` still proceeds and prints a warning naming both.
  `--yes-production` always wins.
- Guided mode never passes `--yes-production` for you. For a write-capable step it previews the
  resolved target and whether it would be confirmed or refused, before asking you to run it.

A write-capable command writes only with `--write-db`; without it, you get a preview of what would
happen.

---

## 3. Workflow: ingest a new unit

This is what guided mode's "Ingest a new unit" workflow automates. The direct-command version, step
by step, is for a unit with no topics yet.

Once a unit has generated questions, do not repeat this workflow or step 2's plain topic extraction
against it: re-extracting topics can rename or reorder them and break the link between existing
questions and their topics. For a unit that already has questions, use "Fixing an existing unit" at
the end of this section.

**0. Drop the PDF(s) in place.** Put the unit's source PDF(s) in `apps/pipeline/content/pdf/`
(gitignored). A unit is matched to its files by name: a new unit has no recorded `source_file_stem`
yet, so the pipeline searches `content/pdf/` for a filename containing the unit's label (`unit-1`
maps to "Unit 1"), regardless of how the course-year prefix is spelled. A file named
`Spanish 2 Unit 1 Full.pdf` matches `unit-1`. Once a unit has been processed, its matched filename is
recorded as `source_file_stem` in the `units` table and later runs resolve it directly.

**1. Convert PDF to markdown.**

```bash
pipeline pipeline-run unit-1 --convert-only
```

Writes to `apps/pipeline/content/markdown/`. Every slide is rendered as an image and transcribed by
a vision model, so slide screenshots are transcribed too, not just their text layer. A second model
first classifies each slide and skips those that teach no course content; pass `--exclusion-pass
off` to transcribe every slide instead. Each PDF also gets a `<name>.conversion-report.json` listing
slides flagged for low text coverage and slides that were image-dominated. Check that report and the
output markdown before moving on: it is the source text every later stage reads.

**2. Extract and review topics, then generate questions.**

```bash
pipeline pipeline-run unit-1 --review-topics --write-db --skip-resources
```

`--review-topics` runs an interactive review of the extracted topics before they are upserted. It is
worth doing for a brand-new unit, since this step also creates the unit's row in the `units` table.
Before the review prompt, `content-suggest-topics` prints each topic with its exact headings and the
size of the content they resolve to (section count, character count, `<!-- slide N -->` range),
flags any topic with no heading or no matched content, and notes how many nested headings were
collapsed. A **WARNINGS** section follows the table with non-blocking hints (identical content
across topics, one topic's content inside another's, a thin topic, a section linked by three or more
topics, a topic whose headings share no word with its name). None fail the run: a unit can
legitimately have topics that share a practice slide or are phrased differently than their headings.
`--skip-resources` defers learning-resource extraction to its own step (section 6). Questions are
inserted with `quality_status: 'pending'`, not yet served, with each topic and difficulty getting a
question count set from how much material the topic resolves to (section 4); add `--count <n>` to
override it for the whole unit.

Check afterward that the topic list looks right (no near-duplicate topics, no topic with no heading
or no content, no warning that turns out to be a real mapping mistake) and that the question count
and type/difficulty distribution look reasonable (`pipeline db-export-questions --unit unit-1`, or a
look at the `questions` table).

**3. Audit the new questions.** Batch is cheaper per question but turnaround is set by OpenRouter and
can be hours; sync is immediate and is usually the better choice for one unit's questions. Section
5's "Sync vs. batch" has the tradeoff. Batch:

```bash
pipeline questions-audit --unit unit-1 --pending-only --llm-batch
```

This submits the audit as an OpenRouter batch job and records it in the `llm_batch_jobs` table. Note
the job id the command prints. Or sync, for an immediate result:

```bash
pipeline questions-audit --unit unit-1 --pending-only --write-db
```

**4. If auditing by batch, resume once it completes.** Skip this step if step 3 used the sync
command.

```bash
pipeline questions-audit --llm-batch-resume <job-id> --write-db
```

This polls the job and, once it is done, applies the results: questions that pass the 6-criteria
gate move to `quality_status: 'active'` (served to students); questions that fail move to
`flagged`. If you do not have the job id handy, guided mode's "Resume a batch audit" workflow lists
every job in `llm_batch_jobs` with `applied_at IS NULL`.

**5. Extract learning resources.** Step 2's `--skip-resources` deferred this; run it now that the
unit's questions are audited:

```bash
pipeline content-extract-resources --unit unit-1 --write-db
```

### Fixing an existing unit

If a unit's topics already have questions generated against them, its topic *names* have to stay
stable, but its `headings` can still be wrong or missing (see "Topic heading does not match the
document" in section 8). Rebuild them without touching the names:

```bash
pipeline content-suggest-topics apps/pipeline/content/markdown/Unit\ 1.md unit-1 --map-existing
```

This asks the model to assign each of the unit's existing topic names to verbatim headings from the
document, validates every assignment the same way normal extraction does (one corrective retry, then
a loud failure naming any heading that still does not match), collapses nested headings, and writes a
proposal (per-topic headings, section count, character count, and slide range) to
`apps/pipeline/content/exports/heading-repair-unit-1.{json,md}`. It previews by default; add
`--write-db` to write the repaired headings to the `units` table.

**Applying a hand-corrected proposal.** The model's proposal can have mapping mistakes: heading text
repeats across a document ("Warm Up", "Exercices"), so the model can point a topic at the wrong
occurrence. Edit `apps/pipeline/content/exports/heading-repair-unit-1.json` directly (fix a topic's
`headings` array: a bare string when the heading text is unique in the document, `{ "heading":
"...", "slide": N }` when it is not), then apply it without calling the model again:

```bash
pipeline content-suggest-topics apps/pipeline/content/markdown/Unit\ 1.md unit-1 --map-existing \
  --from-proposal apps/pipeline/content/exports/heading-repair-unit-1.json --write-db
```

`--from-proposal` validates every entry exactly as the model path does, prints the same review table
(including WARNINGS), and either writes what you gave it or fails loudly naming what does not
validate. Only `headings` changes; topic names and every other field on the unit row are untouched,
including topics the proposal does not mention.

Repaired headings resolve to real material the next time anything reads them, including the audit
prompt. If the unit's questions were audited before the repair, re-audit the unit afterward without
`--pending-only`, so already-`active` or already-`flagged` verdicts are re-evaluated against the
now-resolvable material. `questions-audit` has no per-topic filter, so this re-audits the whole unit:

```bash
pipeline questions-audit --unit unit-1 --write-db
```

---

## 4. Workflow: re-run or extend generation for a unit

To see where the corpus stands against the target type/difficulty distribution:

```bash
pipeline questions-plan --analyze-only
```

Drop `--analyze-only` to also produce an execution plan (a set of targeted `questions-generate`
calls), and add `--execute` to run it after an interactive confirmation. `--target-writing <n>`
adjusts the target percentage of writing questions.

For a narrower, manual addition, call `questions-generate` directly with filters:

```bash
# More advanced fill-in-blank questions for one topic
pipeline questions-generate --unit unit-1 --topic "Passé Composé" \
  --difficulty advanced --type fill-in-blank --count 10 --write-db
```

`questions-generate` runs Stage 1 (generation) and Stage 2 (answer validation) together. It routes
by type and difficulty (the smaller model for beginner and intermediate multiple-choice and
true-false, the larger one for typed answers and everything at advanced difficulty) unless `--model`
is passed, which overrides the model for every type and disables hybrid routing. `--skip-validation`
skips Stage 2. New questions land as `pending`; run an audit (section 5) before they are served.

Without `--count`, each topic and difficulty gets a question count computed from its content (see
"Question count" in the [architecture doc](pipeline-architecture.md#question-count)), so a
four-expression slang list and a multi-slide grammar topic do not get the same budget. The model is
asked for "up to" that count, and a thin topic returning fewer is accepted without retry.

**Every unit in scope must already be mapped.** `questions-generate` validates every topic's stored
`headings` against the unit's current markdown before any model call, and exits with an error naming
the unit and every mismatched heading if any do not resolve. A unit whose headings predate
exact-heading matching, or has gone stale, would otherwise generate zero questions per topic without
failing. Map or repair the unit first (section 3's "Fixing an existing unit") and re-run.

---

## 5. Workflow: audit and re-audit

One command, `questions-audit`, with two auditors selected by `--auditor`:

- **`--auditor mistral`** (the default) is an independent, cross-provider evaluator (not the same
  vendor family as generation) against a 6-criteria gate, plus remediation: it relabels difficulty
  when its suggestion differs from the assigned one, and removes invalid entries from
  `acceptable_variations` (subtractive only).
- **`--auditor sonnet`** evaluates a narrower 4-criteria core (`answer_correct`, `grammar_correct`,
  `no_hallucination`, `question_coherent`) with no remediation and no batch mode. Use it for a second
  opinion or a cross-validation run, not as the primary gate.

Both accept the same filters: `--unit`, `--difficulty`, `--type`, `--writing-type`, `--batch-id`,
plus `--limit` for a random sample and `--pending-only` to restrict to ungated questions.

**Reference material and preflight.** Every question is audited alongside an excerpt of the course
markdown its topic was generated from, and the command runs two preflight gates before any model
call: stale topic headings, and a topic that resolves to no material at all. Either gap fails the
run, naming the problem, instead of degrading silently. `--allow-missing-material` skips the second
gate. The reasoning and the exact rules are in "Audit grounding and gate scope" and "Preflight" in
the [architecture doc](pipeline-architecture.md#audit-grounding-and-gate-scope).

**Streaming writes.** Under `--write-db`, each group's results are written as soon as that group's
audit call completes. A long run interrupted partway (crash, Ctrl-C) keeps what it already wrote, and
a re-run with `--pending-only` picks up what is left. Ctrl-C finishes the group already in flight,
prints the summary so far, then exits non-zero.

**Sync vs. batch.** By default both auditors call the model synchronously, one group at a time.
`--auditor mistral` also supports `--llm-batch`, which submits the whole run as one OpenRouter batch
job: cheaper per question, with turnaround set by OpenRouter and not immediate. Generation stays
synchronous either way; batch mode is audit-only and Mistral-only (`--llm-batch` with `--auditor
sonnet` is rejected). Both modes audit with the same Mistral model. Submit with `--llm-batch`, then
apply with `--llm-batch-resume <job-id> --write-db` once the job completes:

```bash
pipeline questions-audit --pending-only --llm-batch              # submit
pipeline questions-audit --llm-batch-resume <job-id> --write-db  # apply, once done
```

If a batch fails whole-scale before it starts running (a malformed request in the batch), resuming it
with `--write-db` falls back to the synchronous endpoint instead of losing the run.

**Reading results.** `--output <path>` exports the per-question results to JSON, useful for manual
review. Without `--write-db`, an audit run is a preview that shows what would change without
touching `quality_status`.

**Lifecycle.** A question moves `pending` → `active` (served to students) once it passes the gate
under `--write-db`, or `pending` → `flagged` (excluded) if it fails. There is no separate "re-audit"
flag: running `questions-audit` again with `--write-db` against the same filter re-evaluates whatever
it fetches and writes the new verdict. With `--pending-only` the fetch is restricted to never-audited
rows, so an `active` or `flagged` question is untouched. Without it, every matching row is
re-audited and the write applies whichever verdict the new run reaches in either direction: `active`
can flip to `flagged` on a newly caught error, and `flagged` can flip back to `active` once a prompt
fix (new reference material, a corrected gate rubric) clears a false positive:

```bash
# Re-audit everything in a batch, including questions already active or flagged
pipeline questions-audit --batch-id <batch-id> --write-db
```

**Usage and cost.** Each question's `audit_metadata` carries its share of the audit call's usage
(tokens, cost, served model) and the rendered prompt's hash. A run prints `Usage: N calls, X prompt /
Y completion tokens, $Z` at the end, and a completed batch job's total cost is written to
`llm_batch_jobs.total_cost_usd`.

---

## 6. Workflow: learning resources

```bash
pipeline content-extract-resources --unit unit-1 --write-db
```

Scans the unit's markdown for URLs (YouTube and others), maps each one to a topic using the same
exact-heading matching question generation uses, and inserts them into the `learning_resources`
table. Without `--write-db` it previews. `--force` re-extracts even where resources already exist for
the unit (normally skipped once populated).

It runs the same preflight as `questions-generate`: every target unit's stored `headings` are
validated against its current markdown before scanning starts, and the command exits with an error
naming the unit and every mismatched heading if any do not resolve.

---

## 7. Exports and utilities

**`db-check-connection`** verifies Supabase connectivity and schema for the core tables. It takes no
options:

```bash
pipeline db-check-connection
```

**`db-export-questions`** exports the `questions` table to JSON, for inspection, archival, or
cross-model audit:

```bash
pipeline db-export-questions --unit unit-1 --columns full --output apps/pipeline/content/exports/unit-1.json
```

`--columns minimal` (default) or `full` controls how many columns are included; the usual filters
(`--unit`, `--difficulty`, `--type`, `--writing-type`, `--batch-id`) narrow the export. The `--output`
path is relative to the shell's working directory.

**`db-seed-study-code-words`** seeds the `study_code_source_words` table with the adjective and
animal word pools used to generate anonymous study codes. The app cannot issue study codes until it
has run:

```bash
pipeline db-seed-study-code-words --dry-run    # preview the sample
pipeline db-seed-study-code-words --count 300 --write-db
```

---

## 8. Troubleshooting

**429 / rate limits during audit.** `questions-audit`'s Mistral synchronous path retries with
exponential backoff. OpenRouter's Mistral pool returns 429 in bursts that can outlast a short
backoff, so a run that logs several retries before succeeding is expected. Persistent 429s across a
whole run are a signal to fall back to `--llm-batch` instead of pushing more retries through the
synchronous path.

**A batch job seems stuck.** Batch turnaround is set by OpenRouter and can be hours. Check status
through the "Resume a batch audit" guided workflow (it lists everything in `llm_batch_jobs` with
`applied_at IS NULL`), or resume directly with `pipeline questions-audit --llm-batch-resume <job-id>
--write-db`. Resuming an in-progress job is a no-op poll, not a re-submission. If the job failed
before execution (a malformed request in the batch, not a normal per-question failure), resuming
with `--write-db` falls back to the synchronous endpoint.

**"Refusing to write" / wrong target refused.** The command resolved a Supabase target that does not
match `EXPECTED_SUPABASE_REF` and was not passed `--yes-production`. See section 2. This is the guard
working as intended. Either export the environment file for the database you mean to write to, or
pass `--yes-production` if the resolved target (printed in the error) really is where you want to
write.

**Topic heading does not match the document.** `content-suggest-topics` (normal extraction,
`--map-existing`, and `--from-proposal`) validates every heading it assigns against the document's
real `#`-headings before it can be written anywhere. A heading fails in two ways. Its text may not
exist in the document at all (or, for a `{ heading, slide }` ref, not on that slide): the model
paraphrased a heading, combined several into one string, or invented one. Or the text may be
*ambiguous*: a bare string that repeats elsewhere in the document, so it needs a `{ heading, slide }`
pair. Normal extraction and `--map-existing` get one corrective retry against the model before
failing; `--from-proposal` makes no model call, so it fails immediately. A failed run prints every
remaining `"topic" → "heading"` mismatch (noting which are ambiguous) and exits with no partial
write. Fix the source markdown or the proposal file and re-run.

**`questions-generate` or `content-extract-resources` refuses to run, naming a unit and a list of
headings.** Both validate every topic's stored `headings` against the unit's current markdown before
doing anything else, the same validation `content-suggest-topics` uses. This stops a unit whose
headings predate exact-heading matching (stored as lowercased word tokens rather than verbatim
heading text) from silently generating zero questions or scanning zero resources per topic. Run
`pipeline content-suggest-topics <markdown-file> <unit-id> --map-existing --write-db` for the named
unit, review the proposal, then re-run.

**Vercel build fails on missing `COURSE_*`.** `COURSE_NAME` and `COURSE_TITLE` fall back to "French
II" / "French II Practice & Assessment" for local development, tests, and local builds, but a Vercel
build or deployment (and any production server) fails without them. Set both in the Vercel project's
environment variables.

---

## 9. End-to-end example: Unit 1 against the test database

Assuming `apps/pipeline/content/pdf/` already has a PDF matching "Unit 1" and `.env.test.local` is
configured with `EXPECTED_SUPABASE_REF` set to the test project's ref:

```bash
set -a; source .env.test.local; set +a

pipeline pipeline-run unit-1 --convert-only
# → review apps/pipeline/content/markdown/<unit-1 file>.md

pipeline pipeline-run unit-1 --review-topics --write-db --skip-resources
# → review the topic prompts as they come up; check the resulting question count/distribution

pipeline questions-audit --unit unit-1 --pending-only --llm-batch
# → note the job id printed

# ... once OpenRouter reports the batch complete ...
pipeline questions-audit --llm-batch-resume <job-id> --write-db
# → passing questions move to 'active'; failing ones to 'flagged'

pipeline content-extract-resources --unit unit-1 --write-db
```

---

## 10. Workflow: evaluating models

The `eval-` commands let you test whether a different model, provider, or setting holds up on the
audit, grading, mapping, or transcription task before adopting it, against a frozen, hashed item
sample rather than production questions, and through the exact prompt builder and parser production
uses. All are dry-run by default; pass `--write-db` to persist anything or call a model. Concepts
and tables are in the
[architecture doc](pipeline-architecture.md#evaluation-framework); each command's behavior is in the
pipeline README. Reports and reviewer sheets must be written outside the tracked tree.

The overall order is: register the models, create a set, label reference where the task needs it,
run a baseline twice, run candidates, compare, then record a decision.

### Registering a model

`eval-run` resolves every `--models` identifier against the model registry (`eval_models_current`)
and refuses to start if any has no row. The registry is empty on a fresh clone, and no command adds
to it, so register each model, including the production baseline, with an insert (for example in the
Supabase SQL editor). A model needs a family row first, then a dated snapshot of its attributes; the
table columns are in `supabase/schema.sql`.

```sql
INSERT INTO eval_model_families (vendor, family) VALUES ('<vendor>', '<family>')
ON CONFLICT (vendor, family) DO NOTHING;

INSERT INTO eval_models
  (family_id, slug, effective_date, price_prompt_usd_per_m, price_completion_usd_per_m,
   context_window, source)
SELECT id, '<openrouter-model-slug>', CURRENT_DATE, <prompt $/M>, <completion $/M>,
       <context window>, 'manual entry'
FROM eval_model_families WHERE vendor = '<vendor>' AND family = '<family>';
```

A model with no price is refused unless `--allow-unpriced`. Snapshots are append-only: to correct a
price, insert a new row with a new `effective_date`.

### Create a set

For the audit task, sample a stratified set of questions from a batch:

```bash
pipeline eval-set-create --task audit --from-batch <batch-id> --unit unit-1 \
  --strata type,difficulty,quality_status --size 150 --balance-status \
  --label "unit-1 audit reference candidate" --write-db
```

`--balance-status` splits the sample 50/50 between flagged and non-flagged questions first, then
stratifies each half. Flagged questions are a minority in production, so a plain proportional sample
would barely include any. The command prints the strata table so you can confirm the split.

For the grading task, it builds one item per active fill-in-blank or writing question times label
class (`correct`, `wrong`, `typo`, `missing_accent`, `valid_paraphrase`, `partially_correct`), each
with an empty answer placeholder:

```bash
pipeline eval-set-create --task grading --from-batch <batch-id> --unit unit-1 --per-question 6 \
  --label "unit-1 grading reference candidate" --write-db
```

### Seed and approve reference

Grading items need a submitted answer before anything can be graded. `eval-seed-grading` fills them
in: `typo` and `missing_accent` are computed deterministically (swapping two characters, stripping
diacritics), and the other four label classes go through one model call per question. Its dry run
prints the pending items by label class and the projected cost without calling a model:

```bash
pipeline eval-seed-grading --set <set-id> --model <seeding-model-slug> --write-db
```

Every item it writes stays `reference_status: 'pending'` until a reviewer approves it. For audit,
approving an item means setting `reference` to the six gate criteria as booleans plus `borderline`
and a `reason` (required whenever a criterion fails or `borderline` is set). For grading, it means
`reference = { "isCorrect": <bool>, "borderline": <bool>, "reason": <string or null> }`: the
reviewer's own verdict on the submitted answer, not a score.

### Building reference labels

`eval-review-export` and `eval-review-import` let a reviewer who does not work in the Supabase table
editor label reference in a spreadsheet. Export a set (choose a path outside the tracked tree):

```bash
pipeline eval-review-export --set <set-id> --out <reviewer-sheet-path>.xlsx
```

The sheet is blind: no `quality_status`, `audit_metadata`, production verdict, or (for grading)
`label_class`, so nothing reveals a model's or production's own opinion of the item. Rows are
shuffled with a seed printed to the console. The `.xlsx` workbook has dropdowns for the verdict
columns and a protected sheet, so only the input columns are editable; add `--format csv` for a plain
CSV. Audit rows carry the question fields plus empty gate-criteria columns, `borderline`, and
`reason`; grading rows carry the question, correct answer, and submitted answer plus empty
`is_correct`, `borderline`, and `reason` columns. The reviewer fills in the empty columns and saves
the file.

Import it back (the format is detected from the extension):

```bash
pipeline eval-review-import --set <set-id> --from <completed-sheet-path>.xlsx \
  --reviewer <reviewer-handle> --rubric-version v1 --write-db
```

Every row is validated before anything is written: unknown or duplicate `item_id`s, malformed
verdict cells, and a missing `reason` where one is required. The whole import is refused if any row
fails. An item already `approved` is left alone unless `--overwrite` is given. For grading,
`--policy-labels` also approves every `typo`/`missing_accent` item directly: they are excluded from
the export by default and need no reviewer judgment, since the app's fuzzy-match tier accepts those
answers by policy.

`--rubric-version` labels which version of the labeling instructions the reviewer worked from (a
plain string such as `v1`), so a later re-review under a revised rubric can be told apart. Each
`--write-db` import records one `eval_review_rounds` row for the set: the reviewer, the rubric
version, and how many items the run wrote. `--rubric-hash` and `--calibration-result` (a JSON object
such as `{"pilot_agreement": 0.92, "pilot_item_count": 20}`) are optional fields on that row.

### Run a baseline twice

Before judging any candidate, establish the reference numbers and the run-to-run noise floor by
running the current production model twice (`--repeat 2`). For audit, the production model is
`MODELS.mistralAudit` in `packages/shared/src/models.ts`:

```bash
pipeline eval-run --set <set-id> --task audit --models <production-model-slug> \
  --repeat 2 --label baseline --write-db
```

Neither `--temperature` nor `--provider` is given on purpose: the audit task defaults to
production's own call settings (including the provider pin), so this baseline reproduces what
`questions-audit` sends rather than an unpinned approximation. Grading's baseline defaults the same
way, to the settings `evaluate-writing`'s route uses.

### Run candidates

Add one or more candidate models. Each is its own variant, and variants are interleaved in blocks of
25 items rather than run start to finish, so provider-routing and time-of-day effects land on every
variant equally:

```bash
pipeline eval-run --set <set-id> --task audit \
  --models <candidate-model-slug>,<other-candidate-model-slug> \
  --label baseline-vs-cross-vendor --write-db
```

`--max-cost` refuses to start any single variant whose projected cost exceeds it, before any call is
made, and a model with no listed price is refused the same way unless `--allow-unpriced`.
`--reasoning off` or an effort tier, `--provider <tag>`, and `--temperature` apply to every variant
in the invocation.

### Naming the question under test

An experiment names the question being tested, so runs can be attributed to it and a decision
recorded against it. Create one with `eval-experiment-create`, declaring each variant in a JSON file
(`--variants`) and, optionally, a decision-rule override (`--decision-rule`):

```bash
pipeline eval-experiment-create --slug <slug> --question "<falsifiable question>" \
  --tasks audit --variants <variants-file>.json --write-db
```

Then attribute runs to it with `--experiment <id-or-slug>`, so their `eval_runs` rows carry
`experiment_id`:

```bash
pipeline eval-run --set <set-id> --task audit --models <candidate-model-slug> \
  --experiment <experiment-id-or-slug> --label candidate-a --write-db
```

An `--experiment` value that does not resolve refuses the whole run, the same way an unregistered
model does. A run made without `--experiment` is ad hoc: it can be compared, but there is no
experiment to decide against.

### Group-context experiments on the audit task

The audit's verdict on a question depends on which other questions share its call, not only on
run-to-run randomness: regrouping the same reference set changes the verdict on some items far more
than a same-group repeat does. This is why production audits each question alone. `--group-size` and
`--shuffle-groups` let you test that sensitivity directly:

```bash
# Production's own grouping: each question alone. This is eval-run's default for the audit task.
pipeline eval-run --set <set-id> --task audit --models <production-model-slug> \
  --group-size 1 --label context-free --write-db

# Five questions to a call, deterministically regrouped. A repeat's disagreement now measures
# group-context sensitivity instead of only run-to-run noise.
pipeline eval-run --set <set-id> --task audit --models <production-model-slug> \
  --group-size 5 --shuffle-groups 7 --label regrouped-seed-7 --write-db
```

A larger group costs less per item, since its calls amortize one shared material block across more
questions, and `eval-run`'s cost projection accounts for that. `--shuffle-groups <seed>` permutes item
order before grouping: different seeds regroup differently from each other and from production's
id-order grouping, and the same seed reproduces the same groups. Both settings are recorded on the
run (`eval_runs.settings.groupSize` and `shuffleSeed`), which is how `eval-compare` labels a
noise-floor repeat as same-group or regrouped.

### Mapping task (does a cheaper model map topics to the same headings?)

The mapping task has no seed or approve step: reference is the unit's own current, validated
headings, set at `eval-set-create` time. Create one item per topic of a unit:

```bash
pipeline eval-set-create --task mapping --unit unit-1 \
  --markdown "apps/pipeline/content/markdown/Unit 1.md" \
  --label "unit-1 heading mapping" --write-db
```

This refuses if any topic has no headings; repair it first with `content-suggest-topics
--map-existing`. Run a baseline and a candidate, several repeats each, since one call covers every
topic in the set (the shape `content-suggest-topics --map-existing` sends in production):

```bash
pipeline eval-run --set <set-id> --task mapping --models <production-model-slug> \
  --repeat 3 --label baseline --write-db

pipeline eval-run --set <set-id> --task mapping --models <candidate-model-slug> \
  --repeat 3 --label candidate --write-db
```

`eval-compare` reports mapping's own shape: mean per-topic F1 with a 95% confidence interval, the
fraction of topics scored a perfect 1, unresolved-heading and nested-duplicate counts, cost and
latency, a paired test on the F1 difference against the baseline, and the noise floor from the
repeats.

### Transcription task (does a cheaper vision model transcribe slides as well as production?)

Transcription's reference is a checked transcript reviewed after the fact. The order is: create the
set, run a baseline, export reference prefilled from the baseline, check each slide against its
image, import, run candidates, compare.

1. **Create the set.** It draws `--per-category` slides from each of three categories
   (image-dominated, text, and a "mixed" category derived from text-layer length), using the PDF's
   own conversion report:

   ```bash
   pipeline eval-set-create --task transcription --unit unit-1 \
     --pdf "apps/pipeline/content/pdf/Unit 1.pdf" \
     --report "apps/pipeline/content/markdown/Unit 1.conversion-report.json" \
     --per-category 10 --label "unit-1 transcription" --write-db
   ```

   It refuses if a category has fewer slides than requested. Reference starts `pending`.

2. **Run the baseline.** Use the model production transcription already uses, so its deterministic
   checks (coverage, no-content marker, table shape), cost, and latency are on record before any
   candidate runs:

   ```bash
   pipeline eval-run --set <set-id> --task transcription --models <production-model-slug> \
     --label baseline --write-db
   ```

3. **Export reference, prefilled from the baseline.** One `<slide>.md` file per item, plus a
   `README.md` listing every slide and its category:

   ```bash
   pipeline eval-review-export --set <set-id> --out <reference-directory> \
     --from-run <baseline-run-id>
   ```

4. **Check each slide against its image and correct the file in place.** Open each slide's rendered
   image (or the source PDF at that slide) next to its prefilled `<slide>.md` and edit it into a
   checked transcript. Replace the whole file with the line `<!-- no teaching content -->` for a
   slide with none.

5. **Import the checked reference:**

   ```bash
   pipeline eval-review-import --set <set-id> --from <reference-directory> \
     --reviewer <reviewer-handle> --rubric-version v1 --write-db
   ```

   It refuses to write anything if any item's file is missing or empty. `--rubric-version` is
   required here too, and this import records the same `eval_review_rounds` row a spreadsheet import
   does.

6. **Run candidates and compare:**

   ```bash
   pipeline eval-run --set <set-id> --task transcription --models <candidate-model-slug> \
     --label candidate --write-db

   pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
     --write-db
   ```

   `eval-compare` reports transcription's own shape: mean score (`1 - normalized edit distance`) with
   a 95% CI, the worst slide, mean text coverage, no-content and table-structure agreement with
   reference, cost and latency, a paired test against the baseline, and the noise floor from any
   repeats. Run before reference is imported, it falls back to a reference-free report of agreement
   between each candidate's and the baseline's own transcript, which is not an accuracy figure.

For a comparison that does not lean on a checked transcript (which was itself seeded from
production's output), `eval-judge` has a third model pick the better of two transcription runs from
the slide image directly:

```bash
pipeline eval-judge --runs <run-a-id>,<run-b-id> --judge-model <judge-model-slug> --write-db
```

### Compare

```bash
pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
  --write-db
```

The report is written to the default report folder (see "Evaluation commands" in the pipeline
README; `EVAL_REPORTS_DIR` changes it). It pairs each candidate against the baseline on their shared,
reference-approved items and gives the agreement, McNemar's exact test, a 95% confidence interval on
the difference, and the non-inferiority verdict against the task's tolerance (`TASK_TOLERANCES` in
`apps/pipeline/src/lib/eval/tolerances.ts`). When the run set includes two runs of the same model, it
also reports the noise floor those repeats establish; a difference smaller than the noise floor is
not a finding. `--write-db` additionally writes the comparison into each run's
`eval_runs.summary.compare`.

For audit, the headline is the "Per-criterion verdict" section: each of the six gate criteria's own
recall and precision, computed independently for baseline and candidate and checked against the
tolerance. The pooled statistic above it ("correlated pairs") is informational only, because a
question flagged on one criterion is more likely to be flagged on others, so pooling reads more
confident than the evidence supports. The report also lists the items where the baseline and a
candidate disagree, under "Items to adjudicate", with each run's per-criterion verdict and the
auditor's stored notes. For grading, the pooled statistic is the real headline.

**When the set has no approved reference yet** (still waiting on a reviewer, or you only want to
check stability first), `eval-compare` does not exit. It reports item-level agreement between each
candidate and the baseline, per-criterion flip counts and flag rates for audit, cost and latency per
run, and the noise floor from any repeats, headed "no reference: stability and agreement only; no
accuracy verdict". A repeat's noise floor is labeled `identical-groups` or `different-groupings`,
which tells a same-group repeat's small disagreement (run-to-run noise) apart from a regrouped
repeat's larger one (group-context sensitivity, above). There is no non-inferiority verdict in this
report; approve reference and rerun for that.

If a reviewer changes reference after a run was scored, `eval-rescore` recomputes the run's scores
and summary from what is already stored, with no model call:

```bash
pipeline eval-rescore --set <set-id> --write-db
```

### Recording a decision

Comparing runs and deciding what to do about the comparison are separate steps. `--write-db` on
`eval-compare` only persists the comparison; it never touches `eval_findings` or an experiment's
status. Recording a decision is `--decide <adopt|reject|defer>` plus a required `--statement "<one
line>"`, which also needs `--write-db`, a candidate run that carries an `experiment_id`, and
attribution (`--decided-by <name>` or `EVAL_DECIDED_BY`). With more than one candidate in `--runs`,
`--candidate <run-id>` says which one the decision is about. `adopt` is refused unless the
comparison produced a non-inferior verdict against a reference; `reject` and `defer` need no
verdict, since either can be a judgment the numbers alone do not settle.

```bash
pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
  --candidate <candidate-run-id> --write-db --decide adopt --decided-by <name> \
  --statement "Candidate matches baseline within tolerance; adopting for this task."
```

This writes one `eval_findings` row citing both run ids and moves the experiment to `decided`
(adopt or reject) or `deferred`. Because `eval_findings` is append-only, deciding the same
baseline and candidate pair again under the same experiment is refused unless `--supersedes
<finding-id>` names the earlier one.

To write down an observation that is not a decision (and so never moves an experiment's status), use
`eval-finding`:

```bash
pipeline eval-finding --statement "<one paragraph>" --runs <run-id>,<run-id> --decided-by <name> \
  --write-db
```
