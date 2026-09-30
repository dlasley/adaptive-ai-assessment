# Content pipeline: ingestion and question generation

A task-oriented walkthrough of `apps/pipeline` for a developer or teacher-operator who has cloned
this repo and wants to add a unit, generate questions for it, and get them audited into
production. For full flag reference on every command, run `pipeline <command> --help` or see
[`apps/pipeline/README.md`](../apps/pipeline/README.md), which this guide complements rather than
duplicates.

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

`npm install` at the repo root installs and links all three workspaces (`apps/web`,
`apps/pipeline`, `packages/shared`) and also links the `pipeline` bin, so `npx --no -- pipeline --help`
works immediately from the repo root. No further setup needed.

Always run the npx form from inside this repo, as `npx --no -- pipeline`. Outside the repo, a plain
`npx pipeline` falls back to downloading and running an unrelated public npm package named
`pipeline`; `--no` makes npx stop instead, and `--` keeps npx from reading the command's options as its own. To use bare `pipeline` from any folder, register it
once with `npm link` in `apps/pipeline`.

Three equivalent ways to run a command:

```bash
pipeline questions-generate --unit unit-2 --write-db          # bare `pipeline`, once on PATH
npx --no -- pipeline questions-generate --unit unit-2 --write-db      # npx, from the repo root
npx tsx apps/pipeline/src/commands/questions-generate.ts --unit unit-2 --write-db  # direct long form
```

All three behave identically: same flags, same stdout/stderr, same exit code. This guide shows the
`pipeline <command>` form throughout.

`pipeline` with no arguments, at an interactive terminal and outside CI, starts **guided mode**:
pick a command or a named workflow, answer its options one at a time (choices as select lists,
booleans as yes/no, required fields enforced), see the equivalent direct command, and confirm
before it runs. Guided mode offers two multi-step workflows:

- **Ingest a new unit**: convert PDF(s), review extracted topics, generate questions, submit a
  Mistral batch audit. Section 3 below walks through the same steps by hand.
- **Resume a batch audit**: lists pending jobs from `llm_batch_jobs` and resumes the one you pick.

Both workflows, and any guided command that writes to the database, check the target first and
stop before running anything unless the write is confirmed through `EXPECTED_SUPABASE_REF`. For
the test database, load `.env.test.local` into the terminal before starting (`set -a; source
.env.test.local; set +a`). Guided mode never passes `--yes-production`; production runs use the
direct commands.

Guided mode never changes how a command behaves when run directly. It only constructs the same
argv the command's own flag parser would accept.

### Shell completion

```bash
pipeline completion zsh    # print a zsh completion script
pipeline completion bash   # print a bash completion script
pipeline completion        # print install instructions, no script
```

Two ways to install, pick one:

**(a) Always current, ~200ms per new shell.** Add this line to `~/.zshrc`, *after* the line that
calls `compinit` (usually `autoload -U compinit && compinit`, near the top of the file):

```zsh
source <(pipeline completion zsh)
```

Then reload with `exec zsh`. This regenerates completions (command names, flags, choice values,
and `--unit` candidates read from `apps/pipeline/content/pdf/`) fresh on every new shell, so they
never go stale as commands or PDFs are added, at the cost of importing every command module on
every shell start. Bash only supports this mode: add `source <(pipeline completion bash)` to
`~/.bashrc` instead.

**(b) Faster shell start, manual refresh.** Write the script once to a file on `fpath`, *before*
the `compinit` line in `~/.zshrc`:

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
PDF, or pulling changes. This mode doesn't regenerate itself.

Either mode needs `pipeline` on PATH: run `npm link` inside `apps/pipeline/`, or add
`apps/pipeline/node_modules/.bin` (or the repo root's `node_modules/.bin`, where npm workspaces
also place it) to PATH. `npx --no -- pipeline` always works without any of this, from the repo root.

---

## 2. Safety model

Every pipeline command prints which Supabase project it's about to talk to, before doing anything
else:

```
[INFO] [supabase-target] Supabase target: abcdefghijklmnop (https://abcdefghijklmnop.supabase.co)
```

For a read-only call, that's all that happens: the target is printed and the command continues.
For a **write-capable call** (any command with `--write-db`), the target must additionally be
confirmed, by one of:

- `EXPECTED_SUPABASE_REF` in the environment matches the resolved project ref, or
- the command was invoked with `--yes-production`.

If neither holds, the command prints the mismatch and exits before touching the database. This
exists because dotenv doesn't override an already-exported shell variable, so loading `.env.local`
silently keeps whatever `.env.local` currently points at. Exporting `.env.test.local` by hand, and
forgetting to, both look identical until a write lands somewhere unexpected.

In practice:

- Set `EXPECTED_SUPABASE_REF` only in `.env.test.local`, to the test project's ref (the subdomain
  in its `NEXT_PUBLIC_SUPABASE_URL`, e.g. `abcdefghijklmnop` from
  `https://abcdefghijklmnop.supabase.co`). Leave it unset in `.env.local` (production), so every
  production write needs an explicit `--yes-production`.
- For a routine run against the **test database**, export `.env.test.local` into the shell before
  running any pipeline command. `pipeline` only loads `.env.local` on its own, never
  `.env.test.local`:

  ```bash
  set -a; source .env.test.local; set +a
  pipeline questions-generate --unit unit-1 --write-db
  ```

- For a **production** write, pass `--yes-production` explicitly. A `--yes-production` run whose
  target differs from a set `EXPECTED_SUPABASE_REF` still proceeds, and prints a warning naming
  both. `--yes-production` always wins.
- Guided mode never passes `--yes-production` on your behalf. For a write-capable step it previews
  the resolved target and whether it would be confirmed or refused, before asking you to run it.
  If it would be refused, running it anyway just reproduces the same refusal from the spawned
  command.

Every write-capable command also defaults to a dry run: `--dry-run` (or, for commands that only
ever preview under `--write-db`, the plain no-flag invocation) shows what would happen without
writing anything. `--write-db` is the flag that turns a preview into an actual write.
`--sync-db`/`--mark-db` are deprecated aliases for `--write-db`; either still works, with a
deprecation warning.

---

## 3. Workflow: ingest a new unit

This is what guided mode's "Ingest a new unit" workflow automates. The direct-command version,
step by step, is for a unit with no topics yet.

Once a unit has generated questions, do not repeat this workflow or step 2's plain topic
extraction against it: re-extracting topics can rename or reorder them and break the link between
existing questions and their topics. For a unit that already has questions, use "Fixing an
existing unit" at the end of this section instead.

**0. Drop the PDF(s) in place.** Put the unit's source PDF(s) in `apps/pipeline/content/pdf/`
(gitignored). A unit is matched to its files by name: a new unit has no recorded
`source_file_stem` yet, so the pipeline searches `content/pdf/` for a filename containing the
unit's label (e.g. `unit-1` maps to "Unit 1"), regardless of how the course-year prefix is
spelled. A file named `Spanish 2 Unit 1 Full.pdf` matches `unit-1`. Once a unit has been processed,
its matched filename is recorded as `source_file_stem` in the `units` table, and later runs
resolve it directly without re-searching.

**1. Convert PDF to markdown.**

```bash
pipeline pipeline-run unit-1 --convert-only
```

Writes to `apps/pipeline/content/markdown/`. Every slide is rendered as an image and transcribed by
a vision model, so slide screenshots get transcribed too, not just their text layer. Each PDF also
gets a `<name>.conversion-report.json` listing slides flagged for low text coverage and slides that
were image-dominated. Check that report and the output markdown before moving on. This is the
source text every later stage (topics, generation, audit) reads from.

**2. Extract and review topics, then generate questions.**

```bash
pipeline pipeline-run unit-1 --review-topics --write-db --skip-resources
```

`--review-topics` runs an interactive review of the extracted topics before they're upserted.
Worth doing for a brand-new unit, since this is also the step that auto-creates the unit's row in
the `units` table. Before the review prompt, `content-suggest-topics.ts` prints each topic with
its exact headings and the size of the content they resolve to (section count, character count,
`<!-- slide N -->` slide range), flagging any topic with no heading or no matched content, and noting
how many nested headings were collapsed from a topic's list (a parent heading and one of its own
child headings, assigned to the same topic, would otherwise double-count that content). A
**WARNINGS** section follows the table, grouping non-blocking hints worth a glance: topics whose
content is identical, one topic's content sitting entirely inside a single other topic's (e.g. one
topic got the parent heading and another got only one of its children), a topic whose content is
under a small character threshold, a single section linked by three or more topics, and a topic
whose linked headings share no meaningful word with its name. None of these fail the run: a unit
can legitimately have topics that share a practice slide, or headings phrased differently than the
topic name. `--skip-resources` defers learning-resource extraction to its own step (section 6)
rather than bundling it here. Questions are inserted with `quality_status: 'pending'`, not yet
served to students, with each topic and difficulty getting a question count set automatically from
how much material that topic resolves to (section 4 has the formula); add `--count <n>` to this
command to override it for the whole unit instead of the auto-computed cap.

Check afterward: the topic list looks right (no near-duplicate topics, no topic flagged with no
heading or no content, no warning that turns out to be a real mapping mistake), and the question
count and type/difficulty distribution look reasonable for the unit
(`pipeline db-export-questions --unit unit-1` or a quick look at the `questions` table).

**3. Audit the new questions.** Batch is cheaper per question but can take up to roughly a day to
come back; sync is immediate and is usually the better choice for a single unit's worth of
questions. Section 5's "Sync vs. batch" has the full tradeoff. Batch:

```bash
pipeline questions-audit --unit unit-1 --pending-only --llm-batch
```

`--llm-batch` submits the audit as an OpenRouter batch job (Mistral Large 3)
instead of auditing synchronously, and records the job in the
`llm_batch_jobs` table. Note the job id the command prints.

Or sync, for an immediate result instead:

```bash
pipeline questions-audit --unit unit-1 --pending-only --write-db
```

**4. If auditing by batch, resume once it completes.** Batch jobs can take up to roughly 24 hours.
Skip this step if step 3 used the sync command instead. Resume with:

```bash
pipeline questions-audit --llm-batch-resume <job-id> --write-db
```

This polls the job and, once it's done, applies the audit results: questions that pass the
6-criteria gate move to `quality_status: 'active'` (served to students); questions that fail move
to `flagged`. If you don't have the job id handy, guided mode's "Resume a batch audit" workflow
lists every job in `llm_batch_jobs` with `applied_at IS NULL`.

**5. Extract learning resources.** Step 2's `--skip-resources` deferred this; run it now that the
unit's questions are audited:

```bash
pipeline content-extract-resources --unit unit-1 --write-db
```

Section 6 has the full command reference.

### Fixing an existing unit

If a unit's topics already have questions generated against them, its topic *names* have to stay
stable, but its `headings` can still be wrong or missing (see "Topic heading doesn't match the
document" in section 8). Rebuild them without touching the names:

```bash
pipeline content-suggest-topics content/markdown/Unit\ 1.md unit-1 --map-existing
```

This asks the model to assign each of the unit's existing topic names to verbatim headings from
the document, validates every assignment the same way normal extraction does (one corrective
retry, then a loud failure naming any heading that still doesn't match), collapses any nested
heading a topic was assigned alongside its own parent, and writes a proposal (per-topic headings,
section count, character count, and slide range) to `content/exports/heading-repair-unit-1.{json,md}`.
It's preview-only by default; add `--write-db` to write the repaired headings to the `units` table.

**Applying a hand-corrected proposal.** The model's proposal can have mapping mistakes: heading
text repeats across a document ("Warm Up", "Exercices"), so it's easy for the model to point a
topic at the wrong occurrence. Edit `content/exports/heading-repair-unit-1.json` directly (fix a
topic's `headings` array: a bare string when the heading text is unique in the document,
`{ "heading": "...", "slide": N }` when it isn't), then apply it without calling the model again:

```bash
pipeline content-suggest-topics content/markdown/Unit\ 1.md unit-1 --map-existing --from-proposal content/exports/heading-repair-unit-1.json --write-db
```

`--from-proposal` validates every entry in the file exactly as the model path does, collapses any
nested heading a topic's hand-edited list still names alongside its own parent, and prints the same
review table (including the WARNINGS section), but makes no model call. It either writes what you
gave it or fails loudly naming what doesn't validate. Only `headings` changes; topic names and every
other field on the unit row are untouched, including topics the proposal file doesn't mention.

A unit's repaired headings resolve to real material the next time anything reads them, including
the audit prompt (section 5's "Reference material"). If the unit's questions were audited before
the repair, re-audit the unit afterward, without `--pending-only`, so already-`active` or
already-`flagged` verdicts get re-evaluated against the now-resolvable material rather than staying
on a verdict reached without it. `questions-audit` has no per-topic filter, so this re-audits the
whole unit:

```bash
pipeline questions-audit --unit unit-1 --write-db
```

---

## 4. Workflow: re-run or extend generation for a unit

To see where the corpus currently stands against the target type/difficulty distribution:

```bash
pipeline questions-plan --analyze-only
```

Drop `--analyze-only` to also produce an execution plan (a set of targeted `questions-generate`
calls to bring the corpus into alignment), and add `--execute` to run that plan after an
interactive confirmation. `--target-writing <n>` adjusts the target percentage of writing
questions (default 27).

For a narrower, manual addition instead of the full plan, call `questions-generate` directly with
filters:

```bash
# More advanced fill-in-blank questions for one topic
pipeline questions-generate --unit unit-1 --topic "Passé Composé" \
  --difficulty advanced --type fill-in-blank --count 10 --write-db
```

`questions-generate` runs Stage 1 (generation) and Stage 2 (answer validation) together. It
hybrid-routes by type and difficulty: Haiku for beginner/intermediate multiple-choice and
true-false, Sonnet for typed answers (fill-in-blank, writing) and everything at advanced
difficulty, unless `--model` is passed, which overrides the model for every type and disables
hybrid routing.
`--skip-validation` skips Stage 2 (faster, but no acceptable-variation generation). New questions
land as `pending`; run an audit (section 5) before they're served.

Without `--count`, each topic/difficulty gets a question count computed from how much material that
topic actually has: roughly one question per 150 characters of extracted content, floored at 2 and
ceilinged at 10 (`computeQuestionCap()` in `apps/pipeline/src/lib/pipeline-config.ts`). A 4-expression
slang list and a multi-slide grammar topic don't get the same budget. `--count <n>` overrides the cap
for every topic in the run. Either way the model is asked for "up to" that count; a thin topic
returning fewer is accepted without retry, since padding it out would mean repeating a question or
testing content beyond the material.

The prompt itself treats the material as defining *scope* (which vocabulary, grammar, and cultural
topics to test) rather than as a source of ground truth to copy verbatim. The French and the facts
in every question, answer, and acceptable variation must be correct even when the source slides
contain an error, an imprecise statement, or a student's own wrong answer.

**Before generating anything, every unit in scope must already be mapped.** `questions-generate`
validates every topic's stored `headings` against the unit's current markdown before any model
call, and exits with an error naming the unit and every mismatched heading if a topic's headings
don't resolve: a unit whose headings predate exact-heading matching (or has otherwise gone stale)
would otherwise silently generate zero questions per topic instead of failing. Map or repair the
unit first (section 3's "Fixing an existing unit") and re-run.

---

## 5. Workflow: audit and re-audit

One command, `questions-audit`, with two auditors selected by `--auditor`:

- **`--auditor mistral`** (the default) is the Stage 3 default: an independent, cross-provider
  evaluator (Mistral, not the same vendor family as generation) against a 6-criteria gate, plus
  remediation. It relabels difficulty when the model's suggested difficulty differs from the
  assigned one, and removes invalid entries from `acceptable_variations` (subtractive only, never
  adds).
- **`--auditor sonnet`** evaluates a narrower 4-criteria core (`answer_correct`, `grammar_correct`,
  `no_hallucination`, `question_coherent`) with no remediation, and has no batch mode. Use it for a
  second opinion or a cross-validation run against the Mistral auditor, not as the primary gate.

Both accept the same filters: `--unit`, `--difficulty`, `--type`, `--writing-type`, `--batch-id`,
plus `--limit` for a random sample and `--pending-only` to restrict to ungated questions.

**Reference material.** Every question is audited alongside an excerpt of the course markdown its
topic was generated from: the same `extractTopicContent` lookup Stage 1 makes, grouped by distinct
`(unit, topic)` pair per audit group and truncated per topic so the prompt stays a sane size. This is
what lets the auditor tell taught register, slang, and idiom apart from an actual error, instead of
flagging anything unfamiliar as wrong. The material only settles what's linguistically in scope:
vocabulary, expressions, register, never whether a claim is factually true. Both prompts say
explicitly that a statistic, date, or historical/cultural claim (including a warm-up or discussion
"answer," which is often a sample student answer rather than a verified fact) still has to be judged
on its own accuracy even when the material states it verbatim.

**Preflight.** Before auditing, the command runs two gates and exits, naming the problem, before any
model call: (1) the same heading preflight `questions-generate` runs: any topic with stored headings
that no longer resolve against its unit's current markdown; (2) a check that every audited question's
topic resolves to non-empty content at all, catching what gate 1 can't see: a topic with no stored
headings whose name-substring fallback also fails to match anything, or an unknown unit or topic.
Either gap would otherwise silently degrade to "no material found" instead of failing loudly.
`--allow-missing-material` skips gate 2 (not gate 1) for an operator who has confirmed the gap and
wants to audit anyway without reference material for the affected topics.

**Streaming writes.** Under `--write-db`, each group's results are written to the database as soon
as that group's audit call completes, rather than accumulating the whole run in memory and writing
once at the end. A long run interrupted partway through (crash, Ctrl-C) keeps whatever it already
wrote; a re-run with `--pending-only` picks up only what's left. Ctrl-C finishes the group already
in flight, prints the summary so far, then exits non-zero.

**Sync vs. batch.** By default both auditors call the model synchronously, one group of questions
at a time. `--auditor mistral` also supports `--llm-batch`, which submits the whole run as a single
OpenRouter batch job instead: significantly cheaper per question, but with a turnaround of up to
roughly 24 hours rather than immediate results. Generation (Haiku/Sonnet) stays synchronous either
way; batch mode is audit-only, and Mistral-only. `--llm-batch`/`--llm-batch-resume` with `--auditor
sonnet` is rejected. Both sync and batch mode audit with Mistral Large 3. For batch, submit with
`--llm-batch`, then apply with `--llm-batch-resume <job-id> --write-db` once the job completes:

```bash
pipeline questions-audit --pending-only --llm-batch              # submit
pipeline questions-audit --llm-batch-resume <job-id> --write-db  # apply, once done
```

If a batch job fails whole-scale before it ever starts running (a malformed request in the batch),
resuming it with `--write-db` automatically falls back to the synchronous endpoint instead of
losing the run.

**Reading results.** `--output <path>` exports the audit's per-question results to JSON instead of
(or alongside) writing them to the database, useful for manual review. Without `--write-db`, an
audit run is a preview: it shows what would change without touching `quality_status`.

**Lifecycle.** A question moves `pending` → `active` (served to students) once it passes the gate
under `--write-db`, or `pending` → `flagged` (excluded) if it fails. There's no separate "re-audit"
flag. Running `questions-audit` again with `--write-db` against the same filter re-evaluates
whatever it fetches and writes the new verdict. The distinction is `--pending-only`: with it, the
fetch is restricted to never-audited rows, so an already-`active` or already-`flagged` question is
untouched. Without it, every matching row is re-audited regardless of its current status, and the
write applies whichever verdict the new run reaches in either direction: `active` can flip to
`flagged` on a newly-caught error, and `flagged` can flip back to `active` once a prompt fix (new
reference material, a corrected gate rubric) clears a false positive:

```bash
# Re-audit everything in a batch, including questions already active or flagged
pipeline questions-audit --batch-id batch_2026-02-13_abc --write-db
```

**Usage and cost.** Each question's `audit_metadata` carries its share of the audit call's usage
(tokens, cost, served model) and the rendered prompt's hash; a run prints `Usage: N calls, X prompt
/ Y completion tokens, $Z` at the end (sync and `--llm-batch-resume` alike), and a completed batch
job's total cost is written to `llm_batch_jobs.total_cost_usd`.

---

## 6. Workflow: learning resources

```bash
pipeline content-extract-resources --unit unit-1 --write-db
```

Scans the unit's markdown for URLs (YouTube and others), maps each one to a topic using the same
exact-heading matching question generation uses, and inserts them into the `learning_resources`
table. Without `--write-db` it previews what would be extracted. `--force` re-extracts even where
resources already exist for that unit (normally skipped once populated).

Same preflight as `questions-generate`: every target unit's stored `headings` are validated
against its current markdown before scanning starts, and the command exits with an error naming
the unit and every mismatched heading if any topic's headings don't resolve.

---

## 7. Exports and utilities

**`db-check-connection`**: verifies Supabase connectivity and schema for the core tables. No
options. It's the one command that checks the target itself rather than going through the shared
client helper, since it always inserts and deletes a throwaway row to confirm write access:

```bash
pipeline db-check-connection
```

**`db-export-questions`**: exports the `questions` table to JSON, for inspection, archival, or
cross-model audit:

```bash
pipeline db-export-questions --unit unit-1 --columns full --output content/exports/unit-1.json
```

`--columns minimal` (default) or `full` controls how many columns are included; the usual filters
(`--unit`, `--difficulty`, `--type`, `--writing-type`, `--batch-id`) narrow the export.

**`db-seed-study-code-words`**: (re-)seeds the `study_code_source_words` table with the
adjective/animal word pools used to generate anonymous student study codes:

```bash
pipeline db-seed-study-code-words --dry-run    # preview the sample
pipeline db-seed-study-code-words --count 300 --write-db
```

---

## 8. Troubleshooting

**429 / rate limits during audit.** `questions-audit`'s Mistral synchronous path retries with exponential
backoff (starting at 5s, doubling, capped at 60s, up to 6 attempts). OpenRouter's Mistral pool
returns 429 in bursts that can outlast a short backoff, so a run that logs several retries before
succeeding is expected, not a sign something's wrong. Persistent 429s across a whole run are a
signal to fall back to `--llm-batch` instead of pushing more retries through the synchronous path.

**A batch job seems stuck.** Batch jobs can legitimately take up to roughly 24 hours. Check its
status via the "Resume a batch audit" guided workflow (lists everything in `llm_batch_jobs` with
`applied_at IS NULL`), or resume it directly with `pipeline questions-audit --llm-batch-resume
<job-id> --write-db`. Resuming an in-progress job is a no-op poll, not a re-submission. If the job
failed pre-execution (a malformed request in the batch, not a normal per-question failure),
resuming with `--write-db` automatically falls back to the synchronous endpoint.

**"Refusing to write" / wrong target refused.** The command resolved a Supabase target that
doesn't match `EXPECTED_SUPABASE_REF` and wasn't passed `--yes-production`. See section 2. This is
the guard working as intended. Either export the environment file for the database you actually
mean to write to, or pass `--yes-production` if the resolved target (printed in the error) really
is where you want to write.

**Topic heading doesn't match the document.** `content-suggest-topics.ts` (normal extraction,
`--map-existing`, and `--from-proposal`) validates every heading it assigns against the document's
real `#`-headings before it can be written anywhere. Two ways a heading fails validation: the text
doesn't exist in the document at all (or, for a `{ heading, slide }` ref, doesn't exist on that
slide): the model paraphrased a heading, combined several into one string, or invented one
outright; or the heading text is *ambiguous*: it's a bare string but repeats elsewhere in the
document, so it can't say which occurrence is meant, and needs a `{ heading, slide }` pair instead.
Normal extraction and `--map-existing` get one corrective retry against the model before failing;
`--from-proposal` makes no model call, so it fails immediately. Either way, a run that fails prints
every remaining `"topic" → "heading"` mismatch (noting which are ambiguous) and exits. There's no
partial write: fix the source markdown, the proposal file, or re-run rather than editing around it.

**`questions-generate` or `content-extract-resources` refuses to run, naming a unit and a list of
headings.** Both commands validate every topic's stored `headings` against the unit's current
markdown before doing anything else (generation or extraction), the same validation
`content-suggest-topics.ts` uses. This is what stops a unit whose headings predate exact-heading
matching (stored as lowercased, split-on-whitespace word tokens rather than verbatim heading
text) from silently generating zero questions or scanning zero resources per topic. Run
`content-suggest-topics.ts <markdown-file> <unit-id> --map-existing --write-db` for the named
unit, review the proposal, then re-run.

**Vercel build fails on missing `COURSE_*`.** `COURSE_NAME`/`COURSE_TITLE` fall back to "French
II" / "French II Practice & Assessment" for local development, tests, and local builds, but a
Vercel build or deployment (and any production server) fails without them explicitly set. Set both
in the Vercel project's environment variables.

---

## 9. End-to-end example: Unit 1 against the test database

Assuming `content/pdf/` already has a PDF matching "Unit 1" and `.env.test.local` is configured
with `EXPECTED_SUPABASE_REF` set to the test project's ref:

```bash
set -a; source .env.test.local; set +a

pipeline pipeline-run unit-1 --convert-only
# → review apps/pipeline/content/markdown/<unit-1 file>.md

pipeline pipeline-run unit-1 --review-topics --write-db --skip-resources
# → review the topic prompts as they come up; check the resulting question count/distribution

pipeline questions-audit --unit unit-1 --pending-only --llm-batch
# → note the job id printed

# ... up to ~24h later ...
pipeline questions-audit --llm-batch-resume <job-id> --write-db
# → passing questions move to 'active'; failing ones to 'flagged'

pipeline content-extract-resources --unit unit-1 --write-db
```

---

## 10. Workflow: evaluating models

Commands (`eval-set-create`, `eval-seed-grading`, `eval-run`, `eval-compare`, `eval-review-export`,
`eval-review-import`) let you test whether a different model, provider, or setting holds up on the
audit, grading, mapping, or transcription task before adopting it, against a frozen, hashed item
sample rather than production questions, and against the exact prompt builder and parser production
uses for that task. All are dry-run by default; pass `--write-db` to actually persist anything or
call a model.

### Create a set

For the audit task, sample a stratified set of questions from a batch:

```bash
pipeline eval-set-create --task audit --from-batch batch_2026-02-13_abc --unit unit-1 \
  --strata type,difficulty,quality_status --size 150 --balance-status \
  --label "unit-1 audit reference candidate" --write-db
```

`--balance-status` splits the sample 50/50 between flagged and non-flagged questions first, then
stratifies each half. Flagged questions are a minority in production, so a plain proportional
sample would barely include any. The command prints the strata table so you can confirm the split
before it lands.

For the grading task, this instead builds one item per active fill-in-blank/writing question
times label class (`correct`, `wrong`, `typo`, `missing_accent`, `valid_paraphrase`,
`partially_correct`), each with an empty answer placeholder:

```bash
pipeline eval-set-create --task grading --from-batch batch_2026-02-13_abc --unit unit-1 --per-question 6 \
  --label "unit-1 grading reference candidate" --write-db
```

### Seed and approve reference

Grading items need an actual submitted answer before anything can be graded. `eval-seed-grading`
fills that in: `typo` and `missing_accent` are computed deterministically from the correct answer
(swapping two characters, stripping diacritics), and the other four label classes go through one
model call per question. Dry run by default: it prints the pending items by label class, the
deterministic answers it would write, and the projected cost of the model calls the set still
needs, without calling a model. `--write-db` is what actually calls the model and persists answers:

```bash
pipeline eval-seed-grading --set <set-id> --model anthropic/claude-sonnet-5 --write-db
```

Every item it writes stays `reference_status: 'pending'`. It's still reference that needs a reviewer's
approval before `eval-run` will score anything against it; see "Building reference labels" below for
how a reviewer actually does that. For audit, approving an item means setting `reference` to the six
gate criteria as booleans (`answer_correct`, `grammar_correct`, `no_hallucination`,
`question_coherent`, `natural_language`, `register_appropriate`) plus `borderline` (boolean) and
`reason` (a string, required whenever a criterion fails or `borderline` is set). For grading,
approving an item means setting `reference = { "isCorrect": <bool>, "borderline": <bool>, "reason":
<string or null> }`: the reviewer's own correct/incorrect verdict on the submitted answer, not a
0-100 score.

### Building reference labels

`eval-review-export` and `eval-review-import` let a reviewer who doesn't work in the Supabase table
editor label reference through a spreadsheet instead. Export a set to CSV:

```bash
pipeline eval-review-export --set <set-id> --out .private/eval/references/unit-1-audit-reference.csv \
  --format csv
```

The CSV is blind: no `quality_status`, `audit_metadata`, production verdict, or (for grading)
`label_class`: nothing that reveals a model's or production's own opinion of the item, so the
reviewer's judgment isn't anchored by it. Rows are shuffled with a seed printed to the console.
Audit rows carry the question fields plus six empty gate-criteria columns, `borderline`, and
`reason`; grading rows carry the question, correct answer, and submitted answer plus empty
`is_correct`, `borderline`, and `reason` columns. Open the CSV in Google Sheets (or any spreadsheet
tool), fill in the empty columns: `pass`/`fail` per criterion (audit) or `correct`/`incorrect`
(grading), TRUE/FALSE checkboxes work too, and export it back to CSV.

Import it back:

```bash
pipeline eval-review-import --set <set-id> --from reviewer.csv --reviewer jsmith \
  --rubric-version v1 --write-db
```

Every row is validated before anything is written: unknown or duplicate `item_id`s, malformed
verdict cells, and a missing `reason` where one is required (any criterion fails, `is_correct` is
incorrect, or `borderline` is set), and the whole import is refused if any row fails, rather than
partially applying a CSV with errors in it. An item already `reference_status: 'approved'` is left alone
unless `--overwrite` is given. For grading, `--policy-labels` additionally approves every
`typo`/`missing_accent` item directly (they're excluded from the export by default, and don't need
a reviewer's judgment): the app's fuzzy-match tier already accepts those answers by policy.

`--rubric-version` labels which version of the reference-labeling instructions this reviewer worked
from (a plain string such as `v1`); it's required so a later re-review under a revised rubric can be
told apart from this one. Each `--write-db` import records one row in `eval_review_rounds` for the
set: the reviewer, the rubric version, and how many items this run actually wrote. `--rubric-hash`
(a content hash of the rubric text) and `--calibration-result` (a JSON object such as
`{"pilot_agreement": 0.92, "pilot_item_count": 20}`) are optional fields on that same row.

### Run a baseline twice

Before judging any candidate, establish the reference numbers and the run-to-run noise floor by
running the current production model twice (`--repeat 2`):

```bash
pipeline eval-run --set <set-id> --task audit --models mistralai/mistral-large-2512 \
  --repeat 2 --label baseline --write-db
```

Neither `--temperature` nor `--provider` is given here on purpose: the audit task defaults to
production's own call settings (temperature 0.1, pinned to Mistral's infrastructure) unless
overridden, so this baseline actually reproduces what `questions-audit` sends rather than an
unpinned approximation of it. The grading task's baseline defaults the same way, to the settings
`evaluate-writing`'s route uses.

### Run candidates

Add one or more candidate models. Each is its own variant, and variants are interleaved in blocks
of 25 items rather than run start to finish, so provider-routing and time-of-day effects land on
every variant equally:

```bash
pipeline eval-run --set <set-id> --task audit \
  --models google/gemini-2.5-flash,openai/gpt-4.1-mini \
  --label baseline-vs-cross-vendor --write-db
```

`--max-cost` (default $2) refuses to start any single variant whose projected cost (item count
times a per-task mean prompt size times the model's list price) exceeds it, before any call is
made. A model with no listed price is refused the same way, since there is nothing to check against
the cap; pass `--allow-unpriced` to run it anyway, with no cost guarantee for that variant.
`--reasoning off` or an effort tier, `--provider <tag>`, and `--temperature` apply to every variant
in the invocation. A Mistral-family model is automatically throttled to one request per second.

### Naming the question under test

Before anything runs, `eval-run` resolves every `--models` identifier against the model registry
(`eval_models_current`, the latest registered snapshot per identifier) and refuses to start the whole
invocation if any of them has no row there. There's no dedicated command to add one yet; register a
new model with an insert into `eval_models` (see
[`docs/pipeline-architecture.md`](pipeline-architecture.md#evaluation-framework) for the columns)
before running it for the first time.

Attribute the run to a named experiment with `--experiment <id-or-slug>`, so its `eval_runs` rows
carry `experiment_id` and a decision can later be recorded against it:

```bash
pipeline eval-run --set <set-id> --task audit --models google/gemini-2.5-flash \
  --experiment <experiment-id-or-slug> \
  --label candidate-gemini --write-db
```

An `--experiment` value that doesn't resolve to an `eval_experiments` row also refuses the whole run,
the same way an unregistered model does. A run made without `--experiment` is ad hoc: it can still be
compared, but there's no experiment to later decide against (see "Recording a decision" below).

### Group-context experiments on the audit task

The audit's verdict on a question depends on which other questions share its call, not only on
run-to-run randomness: regrouping the same reference set changes the audit's verdict on some items far
more than a same-group repeat does. This is why production audits each question alone.
`--group-size` and `--shuffle-groups` let you test group-context sensitivity directly, against
either production's own context-free baseline or a larger group:

```bash
# Production's own grouping: audit each question alone. This is eval-run's default for the audit
# task, so --group-size 1 here is just explicit.
pipeline eval-run --set <set-id> --task audit --models mistralai/mistral-large-2512 \
  --group-size 1 --label context-free --write-db

# Group questions five to a call, deterministically regrouped — a repeat's disagreement now
# measures group-context sensitivity instead of only run-to-run noise.
pipeline eval-run --set <set-id> --task audit --models mistralai/mistral-large-2512 \
  --group-size 5 --shuffle-groups 7 --label regrouped-seed-7 --write-db
```

`--group-size` (default 1, matching production) changes how many questions share one audit call; a
larger group costs less per item, since its calls amortize one shared material block across more
questions instead of each call repeating it. `eval-run`'s cost projection accounts for this before
any call is made. `--shuffle-groups <seed>` permutes item order before grouping, so two runs with
different seeds are regrouped differently from each other and from production's own id-order
grouping, while two runs with the same seed reproduce the same groups exactly. Both settings are
recorded on the run (`eval_runs.settings.groupSize`/`shuffleSeed`), which is how `eval-compare`
later labels a noise-floor repeat as same-group or regrouped.

### Mapping task (does a cheaper model map topics to the same headings?)

The mapping task has no separate seed/approve step: reference is the unit's own current,
already-validated headings, set immediately at `eval-set-create` time. Create one item per topic of
a unit:

```bash
pipeline eval-set-create --task mapping --unit unit-1 \
  --markdown "content/markdown/Unit 1.md" \
  --label "unit-1 heading mapping" --write-db
```

This refuses if any topic has no headings. Repair it first with `content-suggest-topics
--map-existing`. Run a baseline and a candidate, several repeats each, since one call covers every
topic in the set at once (the same shape `content-suggest-topics --map-existing` sends in
production):

```bash
pipeline eval-run --set <set-id> --task mapping --models anthropic/claude-sonnet-5 \
  --repeat 3 --label baseline --write-db

pipeline eval-run --set <set-id> --task mapping --models anthropic/claude-haiku-4.5 \
  --repeat 3 --label candidate-haiku --write-db
```

`eval-compare` (below) reports mapping's own shape: mean per-topic F1 with a 95% confidence
interval, the fraction of topics scored a perfect 1, unresolved-heading and nested-duplicate counts,
cost and latency, a paired test on the F1 difference against the baseline, and the noise floor from
the repeats (mean absolute F1 difference between them).

### Transcription task (does a cheaper vision model transcribe slides as well as production?)

Unlike mapping, transcription's reference is a checked transcript reviewed after the fact: the workflow
is create set → run a baseline → export reference prefilled from the baseline → check each slide against
its image → import → run candidates → compare.

1. **Create the set.** Draws `--per-category` slides from each of three categories (image-dominated,
   text, and a "mixed" category derived from text-layer length that production doesn't track
   itself), using the PDF's own conversion report:

   ```bash
   pipeline eval-set-create --task transcription --unit unit-1 \
     --pdf content/pdf/"Unit 1.pdf" \
     --report content/markdown/"Unit 1.conversion-report.json" \
     --per-category 10 --label "unit-1 transcription" --write-db
   ```

   Refuses if a category has fewer slides than requested. Reference starts `pending`; there is no
   reviewer step at creation time the way mapping has none at all.

2. **Run the baseline.** The same production model transcription already uses, so its own
   deterministic checks (coverage, no-content marker, table shape) and cost/latency are on record before any
   candidate runs:

   ```bash
   pipeline eval-run --set <set-id> --task transcription --models anthropic/claude-sonnet-5 \
     --label baseline --write-db
   ```

3. **Export reference, prefilled from the baseline.** One `<slide>.md` file per item, plus a README.md
   listing every slide and its category:

   ```bash
   pipeline eval-review-export --set <set-id> --out .private/eval/references/unit-1-transcription-reference \
     --from-run <baseline-run-id>
   ```

4. **Check each slide against its image and correct the file in place.** The operator opens each
   slide's rendered image (or the source PDF at that slide) next to its prefilled `<slide>.md` and edits
   it into a checked transcript: replacing the whole file with the no-content marker line
   `<!-- no teaching content -->` for a slide with none.

5. **Import the checked reference:**

   ```bash
   pipeline eval-review-import --set <set-id> --from .private/eval/references/unit-1-transcription-reference \
     --reviewer jsmith --rubric-version v1 --write-db
   ```

   Refuses to write anything if any item's file is missing or empty. `--rubric-version` is required
   here too, and this import records the same `eval_review_rounds` row a spreadsheet-based import
   would (see "Building reference labels" above).

6. **Run candidates and compare:**

   ```bash
   pipeline eval-run --set <set-id> --task transcription --models google/gemini-2.5-flash \
     --label candidate-gemini --write-db

   pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
     --write-db
   ```

   `eval-compare` reports transcription's own shape: mean score (`1 - normalized edit distance`)
   with a 95% CI, the worst slide, mean text coverage, no-content and table-structure agreement with
   reference, cost and latency, a paired test on the score difference against the baseline, and the noise
   floor from any repeats. Running `eval-compare` before reference is imported (step 3-4 skipped) falls
   back to a reference-free report instead: agreement between each candidate's and the baseline's own
   transcript, by the same edit-distance similarity, clearly labelled as not an accuracy figure.

### Compare

```bash
pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
  --write-db
```

Reports go to the private reports folder (`.private/eval/reports/`) by default; set `EVAL_REPORTS_DIR`
to write somewhere else.

This pairs each candidate against the baseline on their shared, reference-approved items: agreement,
McNemar's exact test, a 95% confidence interval on the difference, and the non-inferiority verdict
against the task's tolerance. When the run set includes two runs of the same model, it also
reports the noise floor those repeats establish; a difference smaller than the noise floor isn't a
finding. The report is always written, even without `--write-db`; `--write-db` additionally writes
the verdict back into each run's own `eval_runs.summary.compare`.

For grading, the pooled statistic in the report's table is the real headline: false-negative rate
is already single-valued, so the paired test over it is a direct, correct measurement.

For audit, the report's pooled statistic (labelled "correlated pairs") is informational only, not
the headline. Pooling every "should flag" (item, criterion) pair across all six criteria into one
McNemar test treats them as independent, but a question flagged on one criterion is more likely to
be flagged on others too, so the pooled p-value reads smaller and the pooled confidence interval
narrower than the independent evidence actually supports. The real verdict is the "Per-criterion
verdict" section beneath it: each of the six gate criteria's own recall and precision, computed
independently for the baseline and the candidate, checked against the task's tolerance (recall
at or above baseline minus 3 percentage points, precision at or above baseline minus 5 percentage
points). The headline there reads "All criteria pass" or names the ones that failed.

For audit runs, the report also lists every item where the baseline and a candidate disagree on at
least one criterion, under "Items to adjudicate", with each run's per-criterion verdict and its
auditor's stored `notes` side by side, capped at 60 items, with a count of the rest, so a human
reviewing the report can see exactly which questions to look at without re-running anything.

**When the set has no approved reference yet** (still waiting on a reviewer, or you only want to check
stability before spending review time), `eval-compare` does not exit: it reports what it can
without ground truth, headed "no reference: stability and agreement only; no accuracy verdict": item-level
agreement between each candidate and the baseline (each run's own verdict, not checked against
anything), per-criterion flip counts and flag rates for audit, cost and latency per run, and the
noise floor from any repeats. A repeat's noise floor is labelled `identical-groups` or
`different-groupings`, read from the repeats' recorded `--group-size`/`--shuffle-groups` settings:
this is how you tell a same-group repeat's small disagreement (run-to-run noise) apart from a
regrouped repeat's much larger one (group-context sensitivity, above). There is no
non-inferiority verdict anywhere in this report; approve reference and rerun `eval-compare` for that.

### Recording a decision

Comparing runs and deciding what to do about the comparison are separate steps. `--write-db` on its
own only ever persists the comparison itself, into `eval_runs.summary.compare`; it never touches
`eval_findings` or an experiment's status, no matter how many times it's rerun. Recording an actual
decision is the separate `--decide <adopt|reject|defer>` plus a required `--statement "<one line>"`,
which also needs `--write-db` and a candidate run that carries an `experiment_id` (set by
`eval-run --experiment`, so an ad hoc run has no experiment to decide against). With more than one
candidate in `--runs`, `--candidate <run-id>` says which one the decision is about. `adopt` is
refused unless that candidate's comparison produced a non-inferior verdict against a reference;
`reject` and `defer` need no verdict, since either can be a judgment call the numbers alone don't
settle.

```bash
pipeline eval-compare --runs <baseline-run-id>,<candidate-run-id> --baseline <baseline-run-id> \
  --write-db --decide adopt \
  --statement "Candidate matches baseline within tolerance; adopting for this task."
```

This writes one `eval_findings` row citing both run ids and moves the experiment to `decided`
(adopt/reject) or `deferred` (defer). Since `eval_findings` is append-only, deciding the same
baseline/candidate pair again under the same experiment is refused unless
`--supersedes <finding-id>` names the earlier one.
