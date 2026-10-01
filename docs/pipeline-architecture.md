# Question Generation Pipeline Architecture

## Overview

Questions go through three independent stages before reaching students. Each stage has a distinct responsibility and can be run, tuned, or swapped independently.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTENT SOURCES                              │
│  content/pdf/  ──→ content/markdown/  ──→ units table (topics)      │
│  (Sonnet 5)   (Sonnet 5)        (Sonnet 5)                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 1: GENERATION                                                │
│  questions-generate.ts                                │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │ Beginner/Int │    │   Advanced   │    │   --model override   │   │
│  │  MCQ / T-F   │    │  All types   │    │  (e.g. Mistral)      │   │
│  │  Haiku 4.5   │    │  Sonnet 5    │    │  Any supported model │   │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘   │
│         │                   │                       │               │
│         └───────────┬───────┘───────────────────────┘               │
│                     ▼                                               │
│            Structural checks                                        │
│            (type filtering, blank validation, JSON parsing)         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 2: VALIDATION                    (in-process, pre-insert)    │
│  questions-generate.ts → validateAnswers()            │
│  Model: Sonnet 5                                                    │
│                                                                     │
│  For each batch of ~5 questions:                                    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. Answer correctness: is the answer factually right?       │    │
│  │ 2. Grammar check: correct French in question + answer?      │    │
│  │ 3. Difficulty re-labeling: does label match cognitive        │    │
│  │    demand? (beginner/intermediate/advanced)                 │    │
│  │ 4. Acceptable variations: 2-3 alternate answers for          │    │
│  │    typed-answer questions                                   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  Outcomes:                                                          │
│    PASS → insert to DB as quality_status = 'pending'                │
│    FAIL → rejected, logged, not inserted                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 3: AUDIT & REMEDIATION           (separate process)          │
│  questions-audit.ts  Default: --auditor mistral    Model: Mistral Large │
│                      Override: --auditor sonnet       Model: Sonnet 5   │
│                                                                     │
│  Each question is audited alongside an excerpt of the course        │
│  markdown its topic was generated from (extractTopicContent, the    │
│  same call Stage 1 makes) — vocabulary, register, and phrasing the  │
│  material teaches is treated as correct, not flagged as too         │
│  informal/regional/advanced. The material is never authority on     │
│  facts: statistics, dates, and historical/cultural claims (incl.    │
│  warm-up/discussion "answers", often just a sample student answer)  │
│  are still judged for accuracy even if the material states them.    │
│  A two-gate preflight fails loudly before any model call: a stale   │
│  topic heading (Stage 1's own check), or any audited topic          │
│  resolving to no material at all (unknown unit/topic, or a          │
│  headingless topic whose name-fallback also fails) — the latter     │
│  skippable with --allow-missing-material.                           │
│                                                                     │
│  Gate criteria (6 total, all must pass for 'active'):               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. answer_correct: is the answer right?                     │    │
│  │ 2. grammar_correct: is the French correct?                  │    │
│  │ 3. no_hallucination: is the content grounded?                │    │
│  │ 4. question_coherent: does the question make sense?          │    │
│  │ 5. natural_language: does the French sound natural?          │    │
│  │ 6. register_appropriate: is formality level correct?         │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  Soft signals (logged, not gated):                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 7. difficulty_appropriate: is difficulty label correct?      │    │
│  │ 8. variations_valid: are acceptable variations correct?      │    │
│  │ 9. culturally_appropriate: avoids stereotyping, cultural     │    │
│  │    clustering, and stereotypical name-nationality pairings?  │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  Note: Sonnet audit evaluates criteria 1-4 only (no remediation).   │
│  Soft signals 7-9 are Mistral-only.                                 │
│                                                                     │
│  REMEDIATION: Writes to DB (--write-db):                            │
│    audit_metadata JSONB: full diagnostic snapshot per question      │
│    Mistral: applies suggested_difficulty to passing questions       │
│    Mistral: removes invalid_variations from acceptable_variations   │
│                                                                     │
│  Outcomes:                                                          │
│    ALL GATE PASS  → quality_status: 'pending' → 'active'           │
│    ANY GATE FAIL  → quality_status: 'pending' → 'flagged'          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SERVING                                                            │
│  apps/web/src/lib/question-loader.ts                                │
│                                                                     │
│  .eq('quality_status', 'active')                                   │
│                                                                     │
│  Only 'active' questions reach students.                            │
│  'pending' = invisible. 'flagged' = excluded + protected.          │
└─────────────────────────────────────────────────────────────────────┘
```

## Quality Status Lifecycle

```
                    ┌──────────┐
    Generation +    │          │   Audit passes
    Validation ───→ │ pending  │ ──────────────→ active  (served to students)
    passes          │          │
                    └────┬─────┘
                         │
                         │ Audit fails
                         │
                         ▼
                      flagged  (excluded from quizzes)
```

| Status | Visible to students | Can be deleted | How it gets here |
|--------|-------------------|----------------|------------------|
| `pending` | No  | Yes | Inserted by generation after passing validation |
| `active`  | Yes | Yes | Promoted by audit (all gate criteria pass) |
| `flagged` | No  | Yes (via batch cascade) | Demoted by audit (any gate criterion fails) |

## Model Assignments

| Stage | Task | Model | Command |
|-------|------|-------|--------|
| Pre-pipeline | PDF → Markdown (vision, per slide) | Sonnet 5 | `pipeline-run.ts` |
| Pre-pipeline | Topic extraction | Sonnet 5 | `content-suggest-topics.ts` |
| 1 - Generation | MCQ/T-F (beginner/intermediate) | Haiku 4.5 | `questions-generate.ts` |
| 1 - Generation | Typed answers (beginner/intermediate) | Sonnet 5 | `questions-generate.ts` |
| 1 - Generation | All types (advanced) | Sonnet 5 | `questions-generate.ts` |
| 2 - Validation | Answer + grammar + difficulty check | Sonnet 5 | `questions-generate.ts` |
| 3 - Audit & Remediation | Default auditor | Mistral Large | `questions-audit.ts` |
| 3 - Audit & Remediation | Sonnet auditor (`--auditor sonnet`) | Sonnet 5 | `questions-audit.ts` |
| Runtime | Answer evaluation | Opus 5.5 | `api/evaluate-writing/route.ts` |

### Why different models per stage?

- **Generation**: Haiku for structured types (MCQ/T-F) is 10x cheaper than Sonnet with comparable quality. Sonnet handles typed answers and advanced difficulty where calibration matters.
- **Validation**: Sonnet catches grammar/answer errors from both Haiku and Sonnet generation. Acts as a safety net with minimal operational overhead (runs in-process, no separate invocation).
- **Audit**: Mistral Large is the default auditor because it is independent of the generation vendor: it can't share blind spots with the Claude-based generator and validator. Sonnet remains available via `--auditor sonnet` for comparison runs.

### Audit grounding and gate scope

Both auditors receive the same course material each question's topic was generated from
(`buildAuditMaterialsBlock` in `learning-materials.ts`), grouped by distinct `(unit, topic)` pair and
truncated per topic (`AUDIT_MATERIAL_CHARS_PER_TOPIC`) so a group spanning several large topics stays
a sane prompt size. Without this, an auditor with no view of the textbook has no way to distinguish a
real error from taught content it simply hasn't seen: informal register, regional vocabulary, and
colloquial dialogue the material teaches are treated as correct, not flagged as errors.

None of the 6 gate criteria (Mistral) or 4 gate criteria (Sonnet) judge whether a question's
difficulty matches its label. That belongs only to Mistral's `difficulty_appropriate` soft signal.
`register_appropriate` in particular judges whether the French's register is internally consistent
and situationally appropriate, never whether it's too advanced or too informal for the stated level.

For multiple-choice, both auditors are told to compare `correct_answer` against the options by exact
text rather than by re-deriving a lettered position: the stored answer already matches one option's
text verbatim, and letters shown in the prompt are a reading aid, not stored data.

The material's authority is scoped to language, not facts. Both prompts state explicitly that
vocabulary, expressions, and register the material teaches are in scope, but a statistic, date, or
historical/cultural claim is judged on its own accuracy regardless of what the material says. This
includes warm-up/discussion "answers" in course markdown, which are frequently a sample student
answer rather than a verified fact.

### Preflight

`auditHeadingPreflight` runs two gates before any model call, both exiting non-zero and naming the
problem:

1. **Stale headings**. The same check `questions-generate.ts` runs: every topic with stored headings,
   for every unit referenced by the audited questions, must have those headings resolve against the
   unit's current markdown.
2. **Unresolved material**. Gate 1 only inspects topics that already have stored headings. Gate 2
   confirms every audited question's `(unit, topic)` pair resolves to non-empty content via
   `extractTopicContent`, catching what gate 1 can't see: a topic with no stored headings whose
   name-substring fallback also fails to match anything, and an unknown unit or topic. Without this
   gate, any of those cases degraded silently to `buildAuditMaterialsBlock`'s
   `(no source material found for this topic)` placeholder instead of failing the run.

`--allow-missing-material` skips gate 2 for an operator who has confirmed the gap and wants to audit
anyway without reference material for the affected topics; it does not skip gate 1.

## CLI Commands

### Individual stages

```bash
# Stage 1+2: Generate + validate (inserts as 'pending')
pipeline questions-generate --unit unit-3 --write-db

# Stage 3: Audit pending questions with Mistral (default, promotes to active/flagged)
pipeline questions-audit --write-db --pending-only

# Stage 3: Audit with Sonnet instead
pipeline questions-audit --auditor sonnet --write-db --pending-only
```

### Full pipeline

```bash
# All stages chained: PDF → Markdown → Topics → Generation → Audit (Mistral default)
pipeline pipeline-run unit-3 --write-db --audit

# Use Sonnet for audit instead
pipeline pipeline-run unit-3 --write-db --audit --auditor sonnet

# Dry run (shows what would happen without API calls)
pipeline pipeline-run unit-3 --write-db --audit --dry-run
```

### Targeted operations

```bash
# Generate only fill-in-blank, advanced difficulty
pipeline questions-generate --unit unit-2 --type fill-in-blank --difficulty advanced --write-db

# Audit only questions from a specific batch
pipeline questions-audit --auditor sonnet --write-db --batch-id batch_2026-02-13_abc

# Re-audit a batch's active AND flagged questions (omit --pending-only) — a question can flip
# either direction: active -> flagged on a newly-caught error, or flagged -> active once a prompt
# fix (e.g. material grounding) clears a false positive
pipeline questions-audit --write-db --batch-id batch_2026-02-13_abc

# Generate with Mistral (experimental)
pipeline questions-generate --unit unit-2 --model mistral-large-latest --write-db
```

## Batch Audits (opt-in)

`questions-audit.ts`'s default `--auditor mistral` audits synchronously: one `callLlm` request per
question (`AUDIT_GROUP_SIZE` is 1, since verdicts were shown to depend on which other questions
shared the call), in a loop with retry-on-429, applying each result to the database as soon as it
completes when `--write-db` is set. `--llm-batch` and
`--llm-batch-resume` are a mistral-only, opt-in alternative that submits the same groups as a single
OpenRouter batch job instead:

```bash
# Submit the audit as an OpenRouter batch (Mistral Large 3) instead of auditing synchronously
pipeline questions-audit --llm-batch --unit unit-3

# Poll a submitted job; combine with --write-db to apply results once the batch completes
pipeline questions-audit --llm-batch-resume <job-id> --write-db
```

Batch mode targets `mistralAuditBatch` and the sync path targets `mistralAudit`; both are Mistral
Large 3 (`mistralai/mistral-large-2512`), so the two modes differ in price and turnaround, not in
the auditing model.

### `llm_batch_jobs`

Submitting a batch inserts one row into `llm_batch_jobs`, keyed by OpenRouter's `provider_batch_id`.
The row is the bookkeeping needed to resume later: `pipeline_batch_id` (the batch the
audit run belongs to), `custom_id_context` (maps each request's `custom_id` back to the question ids
in that group, so results can be applied without re-deriving the grouping), `status` and
`request_counts` (refreshed on each poll), and `is_fallback_applied`/`applied_at` (see below).

### Resume and apply-once semantics

`--llm-batch-resume <job-id>` polls the batch once. Without `--write-db` it only reports status
(still running, completed, or failed) and writes nothing to `questions`.
With `--write-db`, a completed batch's results are applied through the same
`quality_status`/`audit_metadata` write-db logic the sync path uses (`applyAuditResults`).

Applying is guarded by an atomic conditional claim (`UPDATE llm_batch_jobs SET applied_at = now()
WHERE applied_at IS NULL`): only the resume invocation that wins the claim applies results, so two
concurrent (or retried) resumes against the same job never double-apply. A group with no matching
result in the batch response, or a result whose `custom_id` matches no known group, is never
fabricated a verdict; it's recorded on the job row's `error` column and left `pending` for a later
re-audit.

### Sync fallback on whole-batch failure

A batch can fail before any request in it executes (a malformed request among the group, an invalid
model, etc.), which OpenRouter reports as `status: 'failed'` with no per-request results at all, as
opposed to an ordinary terminal failure after execution began. Resuming such a job with `--write-db`
falls back automatically: each group in `custom_id_context` is re-run one at a time through the sync
endpoint (`mistralAudit`, no retry loop), and the combined results are applied the same way
a normal batch's results would be. `is_fallback_applied` is set only once the fallback has actually
run and its results were applied. A preview-only resume (no `--write-db`) detects and records the
failure but leaves `is_fallback_applied` false, since nothing ran. The fallback's sync calls share one
OpenRouter session id for the whole resume invocation (`<job-id>:audit-fallback`), mirroring how the
ordinary sync CLI path shares one session id across its own per-group loop, so OpenRouter's sticky
routing and dashboard grouping treat the fallback as a single run rather than unrelated calls.

## Design Principles

### Stage independence

Each stage can be run, re-run, or swapped independently:

- **Re-audit without regenerating**: Update audit prompts and re-run `questions-audit.ts` against existing questions. `--pending-only` limits a run to never-audited rows; omitting it re-audits a batch's `active` and `flagged` rows too and writes whichever verdict the new run reaches: a question can move either direction, not just get promoted from pending.
- **Swap generators**: `--model mistral-large-latest` uses Mistral for Stage 1 while Stages 2-3 remain unchanged
- **Tune thresholds per stage**: Validation rejects structurally broken questions; audit evaluates content quality. Different concerns, different prompts.

### Safety net layering

```
Generator errors caught by:   Validation (Stage 2) → Audit & Remediation (Stage 3)
Validation errors caught by:  Audit & Remediation (Stage 3)
Audit errors caught by:       Cross-validation (Mistral vs Sonnet comparison)
Remediation errors caught by: Evaluation fallback tiers (fuzzy → Opus API)
```

No single model failure can put bad questions in front of students. The `pending` quality gate ensures questions are invisible until explicitly promoted.

### Parser strictness

A missing or malformed model response is never treated as a pass. Validation (Stage 2) and audit
(Stage 3, both Mistral and Sonnet) match each response to its question by the `id` the prompt
requires the model to echo back, never by array position: a short, reordered, or malformed
response can't silently validate or activate the wrong question. A question a parseable response
never returned a result for stays pending (validation: counted as `validation_unmatched`; audit: a
per-question `PARSE_ERROR` note); a whole group whose response fails to parse rejects every
question in it (validation: `validation_errors`; audit: a per-question `PARSE_ERROR`/`API_ERROR`
passthrough) rather than passing the group through. Soft signals (audit's `difficulty_appropriate`,
`variations_valid`, `culturally_appropriate`) are informational and still default when absent;
only the gate criteria that decide `active` vs `flagged` are held to this strictness.

### Cost optimization

The hybrid model split routes cheap structured types (MCQ, T-F) to Haiku and expensive typed answers (fill-in-blank, writing) to Sonnet. Advanced difficulty always uses Sonnet regardless of type, for calibration quality.

### Usage and cost tracking

Every OpenRouter call's `usage` object (tokens, cost, served model, BYOK routing) is parsed by
`callLlm` (`packages/shared/src/llm.ts`) into a typed `LlmResult.usage`, and each task that calls
it records what it spent:

- **Generation and validation**: accumulated per stage (`calls`, `prompt_tokens`,
  `completion_tokens`, `reasoning_tokens`, `cost_usd`, `byok_calls`, `json_failures`) and written to
  `batches.quality_metrics.llm_usage.{generation,validation}`.
- **Audit** (Mistral and Sonnet, sync and `--llm-batch-resume`): each question's `audit_metadata`
  carries its share of the call's usage (Mistral divides a group's usage evenly across the
  questions it audited; Sonnet audits one question per call, so there's nothing to divide) and the
  served model. `llm_batch_jobs.total_cost_usd` holds the sum for a completed batch job.
- **PDF conversion**: each slide's `.conversion-report.json` entry under `slideUsage` records that
  slide's usage (absent for a slide served from the on-disk transcription cache, since no call was
  made), and `totalUsage` sums it.
- **Topic extraction and `--map-existing`**: printed as a one-line summary at the end of the run.
- **Student answer grading**: cost, served model, and token counts are added to the structured
  `Evaluation complete` log line, never to any response the student's browser receives.

Every command that made at least one call prints `Usage: N calls, X prompt / Y completion tokens,
$Z` (`apps/pipeline/src/lib/usage-tracking.ts`) once at the end of the run.

### Question count

`questions-generate.ts` sizes each topic/difficulty's question count to that topic's extracted
content rather than using one fixed number for every topic: `computeQuestionCap()` (`apps/pipeline/src/lib/pipeline-config.ts`) gives roughly one question per 150 characters, clamped to 2-10. `--count` overrides the cap for the whole run. The generation prompt asks for "up to" that count: a topic with little material returning fewer questions than the cap is expected, not an error, and isn't retried.

### Grounding vs. correctness

The generation prompt's Reference Materials define scope: which vocabulary, grammar, and cultural
topics are fair game, not a transcript to reproduce uncritically. The French and the facts in every
question, answer, and acceptable variation must be correct independently of the source material, so
a slide's own error, an imprecise statement, or a student's wrong sample answer gets skipped or
corrected rather than tested as true.

## Data Hygiene via Cascade Deletes

All foreign key relationships use `ON DELETE CASCADE` so that deleting a parent record automatically cleans up all dependent data. No orphaned rows, no manual cleanup required.

### Production chain

Deleting a **batch** cascades through:
```
batches → questions → question_results
                    → leitner_state
batches → learning_resources
```

Deleting a **study code** cascades through:
```
study_codes → quiz_history → question_results
study_codes → question_results (direct FK)
study_codes → leitner_state
```

These chains are independent. Deleting a batch does not affect student data, and deleting a student does not affect questions.

## File Map

```
apps/pipeline/
├── bin/
│   └── pipeline.ts                  # `pipeline` dispatcher entry (npm bin target)
├── src/
│   ├── commands/
│   │   ├── pipeline-run.ts          # Pipeline orchestrator (Steps 1-5)
│   │   ├── questions-generate.ts    # Stage 1 (generation) + Stage 2 (validation)
│   │   ├── content-suggest-topics.ts # Pre-pipeline: topic discovery
│   │   ├── content-extract-resources.ts # Extract learning resources from markdown
│   │   ├── questions-plan.ts        # Planning tool: distribution analysis
│   │   ├── questions-audit.ts       # Stage 3 (--auditor mistral default, 6-criteria gate;
│   │   │                            #   --auditor sonnet, 4-criteria gate)
│   │   ├── db-export-questions.ts   # Export questions to JSON
│   │   ├── db-seed-study-code-words.ts # Seed study code word pools
│   │   └── db-check-connection.ts   # Verify database connectivity
│   └── lib/
│       ├── pipeline-steps.ts        # Shared step functions for the orchestrator
│       ├── pdf-conversion.ts        # per-slide vision transcription (image + text-layer hint)
│       ├── unit-discovery.ts        # File resolution for units
│       ├── script-runner.ts         # Process helpers (spawn, prompt)
│       ├── db-queries.ts            # Supabase client + paginated fetch
│       ├── supabase-target.ts       # Write-target guard (EXPECTED_SUPABASE_REF / --yes-production)
│       ├── git-state.ts             # Git state capture for provenance recording
│       ├── pipeline-config.ts       # Re-exports model IDs, type classifications
│       ├── logger.ts                # Pipeline-side structured logger
│       ├── mistral-audit.ts         # Shared logic for --llm-batch / --llm-batch-resume
│       ├── structural-validation.ts # Type/blank/JSON checks before Stage 2
│       ├── writing-type-inference.ts # Writing subtype detection
│       ├── topics.ts                # Topic name normalization
│       ├── units-db.ts              # Fetch units from Supabase
│       ├── learning-materials.ts    # Loads unit markdown; exact-heading section matching + heading validation
│       ├── llm-batch.ts             # OpenRouter batch API client (submitBatch, pollUntilDone)
│       ├── fs-utils.ts              # ensureDirFor() — create an --output path's parent dir
│       ├── paths.ts                 # PDF_DIR/MARKDOWN_DIR/EXPORTS_DIR/COMMANDS_DIR/PROMPTS_DIR anchors
│       ├── env.ts                   # Loads the repo-root .env.local
│       ├── options/                 # Shared option-parsing (define-cli.ts, groups.ts, types.ts)
│       └── dispatch/                # `pipeline` dispatcher internals — discovery, completion,
│                                     # guided mode, workflows (see apps/pipeline/README.md)
├── prompts/                         # Prompt templates (generation, validation, audit, topics)
└── content/                         # Working files (gitignored except .gitkeep)
    ├── pdf/                         # Source course PDFs
    ├── markdown/                    # Converted markdown
    └── exports/                     # JSON/markdown exports, created on demand

apps/web/src/lib/
└── question-loader.ts               # Runtime: loads active questions for quizzes

packages/shared/src/
└── models.ts                        # OpenRouter model slugs per stage/route
```

## Cross-Validation Findings (Sonnet vs Mistral)

Mistral Large is the default Stage 3 auditor because it is provider-independent from the Claude-based generator and validator. The numbers below are a one-time comparison against Sonnet as an alternative auditor, measured on a full-corpus run (1,039 questions) in February 2026; they are not refreshed on a schedule and will drift from the current corpus.

### Agreement on Core 4 Criteria (measured February 2026)

| Criterion | Agreement | Sonnet-only fail | Mistral-only fail |
|-----------|-----------|------------------|-------------------|
| answer_correct | 91.2% | 44 | 47 |
| grammar_correct | 95.9% | 6 | 37 |
| no_hallucination | 91.9% | 76 | 8 |
| question_coherent | 95.4% | 36 | 12 |

### Why Mistral Is the Default

- **476 blind spots Mistral caught that Sonnet missed**, vs 34 the other way (14:1 ratio), measured February 2026.
- **Provider independence**: Sonnet already runs in Stage 2 (validation). Using it again in Stage 3 would let both safety nets share the same blind spots.
- **Core-4 pass rates**: Mistral's are higher than Sonnet's for 3 of 4 question types.
- **Additional criteria**: `natural_language` and `register_appropriate` checks catch quality issues Sonnet doesn't evaluate.

> **Reading the numbers**: The per-criterion table above counts individual criterion disagreements (162 Sonnet-only + 104 Mistral-only). The 476/34 numbers are **question-level**: unique questions where one auditor flagged on *any* criterion while the other passed all. They differ because: (1) Mistral evaluates 6 criteria vs Sonnet's 4, so `natural_language`/`register_appropriate` failures are automatic Sonnet blind spots not reflected in the core-4 table; (2) multiple criterion failures on one question deduplicate at question level; (3) the 34 Sonnet-only count requires Mistral to pass all 6 gate criteria.

### Tiered Gate Design

The 6-criteria gate (core 4 + `natural_language` + `register_appropriate`) reflects each criterion's fail rate on the same February 2026 corpus:

| Criterion | Fail Rate | Gate? | Rationale |
|-----------|-----------|-------|-----------|
| answer_correct | ~6% | Yes | A wrong answer teaches the wrong material |
| grammar_correct | ~4% | Yes | A grammar error teaches incorrect usage |
| no_hallucination | ~5% | Yes | Fabricated content is harmful |
| question_coherent | ~2% | Yes | Unanswerable questions frustrate students |
| natural_language | 4.8% | Yes | Unnatural phrasing affects learning |
| register_appropriate | 2.7% | Yes | Register errors teach wrong usage |
| difficulty_appropriate | 41.0% | No | Too noisy; applied as relabeling instead |
| variations_valid | 22.6% | No | Invalid variations removed as remediation; missing stored in metadata |
| culturally_appropriate | not measured in this pass | No | Flags stereotyping, cultural clustering, and stereotypical name-nationality pairings; logged in `audit_metadata`, no remediation applied |

## Audit Metadata

When `--write-db` is set, Stage 3 writes an `audit_metadata` JSONB column alongside `quality_status`. This persists the full diagnostic snapshot for each question.

### Schema

```jsonc
{
  "auditor": "mistral",              // or "sonnet"
  "model": "mistralai/mistral-large-2512", // exact model ID used
  "audited_at": "2026-02-13T...",    // ISO timestamp
  "gate_criteria": {
    "answer_correct": true,
    "grammar_correct": true,
    "no_hallucination": true,
    "question_coherent": true,
    "natural_language": true,        // Mistral only
    "register_appropriate": true     // Mistral only
  },
  "soft_signals": {                  // Mistral only
    "difficulty_appropriate": false,
    "suggested_difficulty": "beginner",
    "variations_valid": false,
    "missing_variations": ["var1"],
    "invalid_variations": ["var2"],
    "culturally_appropriate": true
  },
  "severity": "minor",
  "notes": "Difficulty mismatch: intermediate -> beginner",
  "usage": {                          // this question's share of its audit call's usage — the
                                       // call's cost and tokens divided evenly across every
                                       // question in its group; null if the call carried no usage
    "prompt_tokens": 620,
    "completion_tokens": 210,
    "reasoning_tokens": null,
    "cost_usd": 0.0009
  },
  "served_model": "mistralai/mistral-large-2512", // the model OpenRouter reports actually served
  "prompt_hash": "a1b2c3d4e5f6a7b8"    // sha256 (16 hex) of the rendered audit system prompt
}
```

A question with no matching audit result (see "Parser strictness" above) is left `pending`; none of the above is written for it.

### What Stage 3 mutates

| Field | Mistral | Sonnet | Condition |
|-------|---------|--------|-----------|
| `quality_status` | Yes | Yes | Always (gate pass/fail) |
| `audit_metadata` | Yes | Yes | Always (diagnostic snapshot) |
| `difficulty` | Yes | No | Only on gate pass, when `suggested_difficulty` differs |
| `acceptable_variations` | Yes | No | Only on gate pass, when `invalid_variations` found |

**Difficulty relabeling**: Stage 2 (Sonnet validation) does a first-pass difficulty check. Stage 3 (Mistral audit) corrects it with better calibration; cross-validation showed Mistral has significantly better difficulty assessment. The `audit_metadata` records the original finding (`suggested_difficulty`), and the `difficulty` column is updated to match.

**Variation removal** (subtractive only): Invalid variations identified by Mistral are removed from `acceptable_variations` on passing questions. This is safe because removal's worst case (rejecting a correct answer) is caught by the evaluation fallback tiers (fuzzy matching → Opus API), while leaving invalid variations in place would silently accept wrong answers with no safety net. `missing_variations` are stored in `audit_metadata` but not applied: adding variations is an additive content modification with no fallback safety net.

### Querying audit metadata

```sql
-- Questions where Mistral flagged difficulty mismatch
SELECT id, difficulty, audit_metadata->'soft_signals'->>'suggested_difficulty'
FROM questions
WHERE audit_metadata->'soft_signals'->>'difficulty_appropriate' = 'false';

-- Questions with missing variations
SELECT id, audit_metadata->'soft_signals'->'missing_variations'
FROM questions
WHERE jsonb_array_length(audit_metadata->'soft_signals'->'missing_variations') > 0;

-- Questions Mistral flagged as culturally inappropriate (stereotyping, cultural clustering, etc.)
SELECT id, question, audit_metadata->>'notes'
FROM questions
WHERE audit_metadata->'soft_signals'->>'culturally_appropriate' = 'false';

-- Audit pass rate by auditor
SELECT audit_metadata->>'auditor', quality_status, COUNT(*)
FROM questions WHERE audit_metadata IS NOT NULL
GROUP BY 1, 2;
```

## Evaluation framework

A separate set of tables and commands (`eval-set-create`, `eval-seed-grading`, `eval-run`,
`eval-compare`, `eval-rescore`, `eval-finding`, `eval-judge`) for testing whether a different model, provider, or setting holds up on a given
task before it's adopted, without touching production questions. See
[`docs/cli-guide-content-ingestion-and-question-pipeline.md`](cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models)
for the workflow and [`apps/pipeline/README.md`](../apps/pipeline/README.md) for full flag
reference. Currently wired up for the audit, grading, mapping, and transcription tasks;
generation and validation share the same tables but have no runner yet.

The task tables, service-role only, no anon policies:

- **`eval_sets`**: one frozen item sample. Records which task it's for, where it was drawn from
  (`source`, a batch id or similar), how it was sampled (`selection`: strata, seed, filters), and a
  hash of the inputs the items depend on (`inputs_hash`: the touched units' markdown and rows), so
  reusing a set later can detect that the underlying material has since changed.
- **`eval_items`**: one row per item in a set, holding a frozen snapshot of its input (`payload`)
  and an optional reviewer-assigned label (`reference`). `reference_status` (`pending` / `approved` /
  `rejected`) tracks review state independently of whether `reference` is populated yet.
- **`eval_runs`**: one variant, one execution against a set. Records the model, the call settings,
  the experiment it's attributed to (if any), and a `summary` JSONB computed once every item has a
  result. `scored_at` and `scoring_review_round_id` are the scoring provenance for that summary: when
  it was last computed (at finalisation or by a later `eval-rescore`) and the newest
  `eval_review_rounds` row on the set at that time, or null when the set had none. Both are columns,
  not keys inside `summary`, so a query for "runs needing a rescore" is a plain `WHERE`.
- **`eval_results`**: one row per (run, item) pair: the variant's output, its deterministic checks,
  score, latency, cost, token usage, and an `error` (`parse` / `api` / `empty`) when the call
  produced nothing usable. `response_meta` carries the OpenRouter response facts that have no
  column of their own (response id, created, each choice's finish reason, cached token counts, the
  upstream-cost breakdown), picked out by name and never including message content. It is kept
  when a call returned content, including content that then failed to parse (`error` `parse`),
  and is null when the call failed or returned no content (`error` `api` or `empty`). A grouped
  audit call (several questions in one call) writes the same `response_meta` on every row in the
  group, since it describes the whole call, not a per-question share. A transcription row gains a
  `classifier` key holding the same fields for its exclusion-pass classifier call (plus that call's
  served model and provider, which the row's own `served_model`/`served_provider` columns describe
  only for the transcription call) when `--exclusion-pass` ran. A transcription row is one of four
  shapes: null (no call returned a response), top-level fields only (no exclusion pass ran),
  top-level plus `classifier` (both calls returned a response), or `classifier` alone, which means
  the transcription call returned nothing to record and is told apart by the row's `error` and
  `deterministic_checks.exclusion_decision`: the classifier dropped the slide (no error, decision
  `drop`, no transcription call made), the transcription call failed after the classifier kept the
  slide (`api` or `empty`, decision `keep`), or the classifier's own response did not parse
  (`parse`, decision null). Nothing reads the column yet; it exists so a question asked later
  about one specific call can be answered from the row.

For the audit task, `eval_items.payload` snapshots a question's fields plus the production
auditor's own verdict (`production_audit`), for a production-verdict comparison when approved
reference isn't available yet. Approved audit reference is the six gate criteria as booleans (the same shape
`audit_metadata.gate_criteria` above uses) plus a reviewer `borderline` flag and `reason`. For the
grading task, one item exists per (question, label class) pair, where the label classes are
`correct`, `wrong`, `typo`, `missing_accent`, `valid_paraphrase`, and `partially_correct`; approved
grading reference is the reviewer's own `isCorrect`/`borderline`/`reason` verdict on the item's
`submitted_answer`, not a score. `eval-review-export`/`eval-review-import` round-trip a set's items
through a blind CSV for a reviewer working in a spreadsheet rather than the Supabase table editor.
Grading's summary also carries `byDesignLabel`, a marked-correct rate per seeded label class
computed from the model's own verdict alone, independent of reviewed reference: available from the
moment a run finishes, unlike `byLabel`, which needs an approved reference and so reads `n: 0` until
one exists.

For the mapping task, one item exists per topic of a unit (`eval_items.payload` is just
`{ unit_id, topic }`); unlike audit and grading, reference is written at `eval-set-create` time, not by a
reviewer: it's the unit's own current, already-validated headings for that topic, normalized to
`{ heading, slide }` form, and `reference_status` is `approved` immediately. `eval_results.score` holds the
per-topic heading-set F1 against that reference; `deterministic_checks` holds the count of returned
headings that resolve in the document, the count that don't (with which ones), and the count covered
by another heading in the same call's response (a nested duplicate, before any collapse).

For the transcription task, one item exists per slide drawn from three categories:
image-dominated and text slides straight from a `*.conversion-report.json`, plus a "mixed" category
derived from text-layer length that production doesn't track itself (see `categorizeTranscriptionSlides`
in `apps/pipeline/src/lib/eval/set-builder.ts`). `eval_items.payload` freezes the slide's own
`pdftotext` text layer (`{ pdf_name, slide, category, text_layer, production_flagged }`). Reference is a
checked transcript, reviewed after the fact like audit/grading: `eval-review-export`/`eval-review-import`
round-trip a set's items through one `<slide>.md` file per item (not a CSV; a transcript is reviewed
against the slide image, not a row of cells). `eval_results.score` holds `1 - normalized edit distance`
against reference (`scoreTranscription` in `apps/pipeline/src/lib/eval/transcription-scoring.ts`);
`deterministic_checks` holds the slide's text coverage, whether the output is exactly the no-content
marker, and the widest markdown table's row/column counts.

`eval-run` calls the exact production prompt builder and parser for each task (the audit
prompt shared with `questions-audit.ts`, the grading prompt shared with `evaluate-writing`'s route,
the mapping prompt and parser shared with `content-suggest-topics --map-existing`, the transcription
prompt and slide renderer shared with `pdf-conversion.ts`'s `convertPdfToMarkdown`) with the model and
settings under test injected, rather than a copy that could drift from what production actually
sends. One call covers every topic in a mapping set at once, matching how the production prompt
works, so a mapping run is one call per variant per repeat rather than one call per item;
transcription stays one call per slide, but renders each slide's image only once per invocation and
reuses it across every variant and repeat. It never reads the production slide cache: every kept
slide is sent to the model on every call, since a cached transcript would record zero cost and make
repeats of a baseline identical by construction, which is not the noise floor being measured.
Transcription also accepts `--exclusion-pass <model>` to gate each slide through a separate
teaching-content classifier before the transcription call, skipping that call and recording the
no-content marker when the classifier judges the slide doesn't teach the course language, with the
decision, reason, and cost recorded on the run's `settings.exclusionPass` and each result's
`deterministic_checks`.
`eval-compare` pairs a candidate run against a baseline run on their shared, reference-approved items and
produces a non-inferiority verdict per task tolerance (audit/grading; transcription's verdict runs
on words captured rather than character similarity and also checks each slide scored in both runs
against the baseline's own word recall and word precision on that slide, not just the mean), or a
paired continuous-metric
comparison alone (mean difference plus an exact sign test, no verdict) for mapping, written back into
`eval_runs.summary.compare`. Unlike mapping, transcription's reference is reviewed after the
fact, so a set with no approved reference yet falls back to a reference-free report: agreement between each
candidate's and the baseline's own transcript, by the same edit-distance similarity, clearly not an
accuracy figure. `--write-db` alone only persists that comparison; recording an actual decision is the
separate `--decide <adopt|reject|defer> --statement "..."`, which writes one `eval_findings` row citing
the compared runs and moves the candidate's `eval_experiments.status` to `decided` or `deferred`. `adopt`
requires a non-inferior verdict against a reference, `reject`/`defer` don't, and a second decision on the
same baseline/candidate pair under the same experiment needs `--supersedes <finding_id>` naming the one
it revises, since `eval_findings` is append-only.

`eval-rescore` recomputes a completed run's per-item scores and `summary` from what's already stored,
with no model call: `outcomeFromStoredResult` (one function per task in `lib/eval/tasks/*.ts`)
rebuilds the outcome `eval-run`'s own `runCall` would have produced, from the stored `eval_results`
row and `eval_items` row alone, so a rescore and a fresh run share one code path rather than two that
can drift apart. This is what actually fills in a run whose `metric_status` reads "scored before
references existed" below: `eval-compare`'s own reference-arrival rescoring is scoped to its paired
comparison and never writes back to the run's own `summary`. Per-item `score` is only touched for
transcription and mapping, the two tasks scored against a reference; grading's score is the model's
own self-score and audit has none. Targets `--run`, `--set`, or `--experiment`; dry run by default.

`eval-finding` is the second, narrower route into `eval_findings`: a plain observation, not an
adopt/reject/defer decision, so it never moves an experiment's status the way `eval-compare
--decide` does. `--experiment` and `--task` are both optional, since an observation can predate a
numbered experiment or not relate to one at all; `--runs` and `--items` are the evidence it cites,
each validated (a run must resolve, an item must belong to the set of one of the cited runs) before
insert. Dry run by default, printing the row it would insert; `--write-db` inserts it with
`decided_by` naming the operator who ran the command.

`eval-judge` is a reference-free alternative to `eval-compare` for the transcription task: instead of
scoring against a checked transcript (itself seeded from production's own model output, so a run
compared through it is partly scored against that model's choices), a third model looks directly at
the slide image and the two runs' transcripts and picks the more complete and faithful one. Every
shared item is judged twice with the two runs' positions swapped, and a run wins the item only when
it wins in both orders, cancelling the judge's position bias. `--write-db` appends an entry to the
list in each judged item's `eval_results.judge_verdict`, keyed first by the other run's id and then
by the judge prompt hash that produced it. Every run of the command appends, so a run can be judged
against several others, and the same pair can be judged again under the same prompt, by the same
judge model or another, with every earlier entry kept; that is what lets the judge's own
run-to-run noise be measured. Each entry carries a `repeat` index (the count of earlier entries from
the same judge model), the call settings the command sent (`judge_call`: the provider pin or null,
reasoning off, no temperature set) and the response facts of both position-order calls (`calls`:
response id, finish reason, the model and host OpenRouter says served each call; never message
content). Stamps `judge_model`/`judge_prompt_hash` on both `eval_runs` rows, which describe the
latest judge call on the run rather than any one pairing. Dry run by default, projecting the judge
cost from the model registry's list price.

### The durable layer: experiments, model registry, findings

More tables sit above the task tables, recording the parts of an evaluation program
that outlive any single run, all service-role only with no anon policies:

- **`eval_experiments`**: one named question under test (for example, whether a cheaper vision model
  transcribes slides as well as production), identified by a descriptive `slug`, its declared
  variants, and the decision rule it will be judged against (a task's default tolerance, or an
  override for this experiment only). `eval-run --experiment <id-or-slug>` attributes runs to it;
  its `status` moves through `proposed`, `running`, and then `decided`, `deferred`, or `superseded`.
  `eval-experiment-create` is the only command that creates or edits this row: it validates the task
  list, each declared variant's model slug against the registry and role against the vocabulary
  existing rows use, the decision rule's keys against `resolveTolerance()`, and dependency slugs
  before writing, and refuses an edit that would drop a declared variant that already has runs
  matching it.
- **`eval_model_families`** / **`eval_models`**: a dated snapshot of a model's attributes (open or
  closed weights, total and active parameter count, architecture, release date, price, context
  window, reasoning support, and known serving hosts), one row per model identifier per
  `effective_date`. Append-only except for `notes` and `family_id`, enforced by a trigger: a
  correction to either of those is a normal update, but a correction to any other attribute (a
  wrong price, a wrong context window) is a new dated row at a new `effective_date`, the same as a
  routine catalog refresh, since a model identifier can silently repoint to different underlying
  weights or pricing later. `eval_models_current` is the latest snapshot per identifier; `eval-run` resolves
  `--models` against it before starting, refusing the whole invocation if a model has no row there.
  `eval_model_families` groups snapshots into a lineage (every release of the same model line) so a
  query can trace one family's trend across versions independent of identifier changes.
- **`eval_findings`**: an append-only record of what was concluded and why, each row citing the run
  and item ids that support it. A finding is `adopt`, `reject`, `defer`, or a plain `observation`; a
  later reversal writes a new row with `supersedes_finding_id` pointing at the one it revises, rather
  than editing the original. `eval-compare --decide <adopt|reject|defer> --statement "..."` writes one
  of these and moves the experiment's status; `eval-finding --statement "..."` writes a plain
  `observation` and never touches the experiment's status.
- **`eval_review_rounds`**: one row per reference-labeling campaign on a set (who reviewed it, under
  what rubric version, with what calibration result against a pilot sample), kept separate from
  `eval_items.reviewed_by`/`reviewed_at`, which are per item. A re-review under a revised rubric adds
  a new round rather than overwriting the claim about what confidence applied under the old one.

These views compute across the tables so a comparison, or the dashboard, doesn't need a
hand-written join each time: `eval_models_current` (latest known snapshot per slug, which `eval-run`
resolves `--models` against when stamping `model_version_id`), `eval_run_scorecard` (one row per
run, with its model's registry attributes and experiment slug joined in, plus its own
`scored_at`/`scoring_review_round_id`), `eval_model_history` (the same information reordered by model
identifier and time, for tracking one model across runs), `eval_run_model_stats` (one row per run
with mean cost, mean latency, error count, and provider-pin mismatch count computed from that run's
own results, plus a cost-per-metric-unit ratio, joined to the model's registry attributes),
`eval_family_history` (`eval_run_model_stats` reordered by model family and effective date, for
tracking a lineage across version changes rather than one identifier), `eval_item_consensus` (one row
per item with at least two completed, non-error runs, with how many runs agree on
`eval_result_verdict`'s per-task verdict: the human-review worklist, ordered by the reader's own
`ORDER BY majority_share`), `eval_run_behaviour` (one row per completed run, reference-free: result
and error counts, parse-failure rate, mean cost, latency p50/p95, and a task-specific behaviour
column that needs no reference, which is what ranks audit and grading variants while their
references are still pending), `eval_variant_stability` (one row per variant identity, grouped on
`experiment_id`, `set_id`, `model`, `prompt_hash`, and the caller-chosen settings keys (including
`mode`, `sync` or `batch`, and `grouping`, `by_order` or `by_topic`; `eval-run` writes neither, so a
run carries `sync` and `by_order` by default), normalized the same way
`normalizeRepeatIdentitySettings` in `apps/pipeline/src/commands/eval-run.ts` does, never on
`variant_label`, with run count, the metric's mean and spread, mean cost, and the run ids),
`eval_experiment_variants` (one row per declared variant, joined to the runs that exist for it by
matching model slug and, for every settings key the declaration carries, the run's own normalized
settings, as `declaredVariantMatchesRun` does in TypeScript; `ambiguous` is true when another
declared variant on the same experiment matches at least one of the same runs, so an overlap is
reported under both rather than one being picked silently. A decision may be made against a baseline
run that belongs to another experiment, so a declaration may carry `baseline_from`, the slug of the
experiment whose runs it draws on; the view then counts that experiment's matching runs and reports
the slug as `runs_from_slug`, null when the runs are the declaring experiment's own. A declaration
whose `model_slug` is `'*'` or null matches no run by design, so a baseline declared that way always
shows no runs), `eval_experiment_dependencies` (one row per `depends_on` entry with that
dependency's current status, or `missing` when no experiment carries the slug), `eval_overview` (one
row of header counts: every table's size, `eval_runs`/`eval_experiments` by status, `eval_findings`
by kind, and the count of registered models), `eval_experiment_summary` (one row per experiment,
with its run count, its finding counts, how many of its declared variants have matched at least one
run per `eval_experiment_variants` (a shared baseline counts as having run), and how many of its
dependencies are not yet decided per `eval_experiment_dependencies`; `finding_count` is every
finding that cites the experiment, superseded ones included, `current_finding_count` and the latest
finding's kind and date read `eval_findings_current`, so a superseded finding never ranks as the
latest), `eval_findings_current` (the findings feed with a `supersedes_finding_id` chain, however
many links deep, collapsed to its most recent entry, carrying the chain's length and the ids it
replaces), and `eval_run_pair_agreement` (one row per unordered pair of completed runs on the same
set, with the number of items both scored without error and the share where they reached the same
verdict; `verdict_kind` names what that verdict is for the task, `is_correct`, `gate_criteria`,
`headings` or `no_content_marker`, so a rate is only comparable within one kind; for transcription it
measures agreement on the no-content marker, not on how alike two transcripts are). Provider-pin
mismatch is compared through
`eval_normalize_provider(name, is_pin)`, a SQL mirror of `normalizeProviderName`/`normalizePin` in
`apps/pipeline/src/lib/eval/compare/shared.ts` (lowercase, strip non-alphanumerics, and for a pin
drop everything after the first `/`), so a hand-typed `--provider anthropic` isn't flagged against
OpenRouter's own `Anthropic`. The per-task verdict compared by `eval_item_consensus` and
`eval_run_pair_agreement` (grading's `isCorrect`, audit's six gate criteria, mapping's heading set,
transcription's no-content-marker decision) lives in one function, `eval_result_verdict(task, output,
deterministic_checks)`, so the two views cannot drift apart on what a verdict means.

The evaluation dashboard (`.private/eval/scripts/dashboard-snapshot.sql`) reads only these views and
plain columns on the underlying tables; it never re-derives an aggregate a view already computes.

Three run views, `eval_run_scorecard`, `eval_run_model_stats` and `eval_run_behaviour`, carry
`metric_status` (`eval_family_history` passes through `eval_run_model_stats`'s), which explains a null
`primary_metric`/`primary_metric_value`
rather than leaving it to guesswork, checked in this order: `failed run` (the run itself didn't
complete); `reference reviewed after scoring` (a metric is present, but either the run's `scored_at`
predates the newest `reviewed_at` among the set's approved items, or an `eval_review_rounds` row on
the set is newer than the one the run was scored against (including any round at all when the run
was scored against none), so a reviewer changed a reference since this summary was computed and
`eval-rescore` would likely change it); `ok` (a metric is present and neither of those holds);
`awaiting reviewed references` (the run's set has no approved reference item yet); `scored before
references existed` (the run's `scored_at`, or its `finished_at` for a run from before that column
existed, is earlier than the set's earliest approved item's `reviewed_at`; re-running `eval-rescore`
fills the metric in); or `no primary metric` (none of the above explains it, worth investigating).

With as few repeats as most of these evaluations run, treat any apparent link between a score and a
specific model attribute (parameter count, architecture, reasoning support) as a hypothesis worth
checking with a larger sample, not a settled finding.
