# Question Generation Pipeline Architecture

## Overview

Questions go through three independent stages before reaching students. Each stage has a distinct responsibility and can be run, tuned, or swapped independently.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTENT SOURCES                              │
│  content/pdf/  ──→ content/markdown/  ──→ units table (topics)      │
│  (vision model)  (per-slide transcript)   (topic extraction)        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 1: GENERATION                                                │
│  questions-generate.ts                                              │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │ Beginner/Int │    │   Advanced   │    │   --model override  │    │
│  │  MCQ / T-F   │    │  All types   │    │  (e.g. Mistral)     │    │
│  │  Haiku       │    │  Sonnet      │    │  Any supported model│    │
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
│  questions-generate.ts → validateAnswers()                          │
│  Model: Sonnet                                                      │
│                                                                     │
│  For each group of questions:                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. Answer correctness: is the answer factually right?       │    │
│  │ 2. Grammar check: correct French in question + answer?      │    │
│  │ 3. Difficulty re-labeling: does label match cognitive       │    │
│  │    demand? (beginner/intermediate/advanced)                 │    │
│  │ 4. Acceptable variations: 2-3 alternate answers for         │    │
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
│  questions-audit.ts                                                 │
│  Default: --auditor mistral (Mistral Large)                         │
│  Override: --auditor sonnet (Sonnet)                                │
│                                                                     │
│  Each question is audited alongside the course material its topic   │
│  was generated from, after a preflight that fails loudly before     │
│  any model call (see "Audit grounding and gate scope" below).       │
│                                                                     │
│  Gate criteria (6 total, all must pass for 'active'):               │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. answer_correct: is the answer right?                     │    │
│  │ 2. grammar_correct: is the French correct?                  │    │
│  │ 3. no_hallucination: is the content grounded?               │    │
│  │ 4. question_coherent: does the question make sense?         │    │
│  │ 5. natural_language: does the French sound natural?         │    │
│  │ 6. register_appropriate: is formality level correct?        │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  Soft signals (logged, not gated):                                  │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 7. difficulty_appropriate: is difficulty label correct?     │    │
│  │ 8. variations_valid: are acceptable variations correct?     │    │
│  │ 9. culturally_appropriate: avoids stereotyping, cultural    │    │
│  │    clustering, and stereotypical name-nationality pairings? │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  Note: the Sonnet auditor evaluates criteria 1-4 only, with no      │
│  remediation. Soft signals 7-9 are Mistral-only.                    │
│                                                                     │
│  REMEDIATION: writes to the DB (--write-db):                        │
│    audit_metadata JSONB: full diagnostic snapshot per question      │
│    Mistral: applies suggested_difficulty to passing questions       │
│    Mistral: removes invalid_variations from acceptable_variations   │
│                                                                     │
│  Outcomes:                                                          │
│    ALL GATE PASS  → quality_status: 'pending' → 'active'            │
│    ANY GATE FAIL  → quality_status: 'pending' → 'flagged'           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SERVING                                                            │
│  apps/web/src/lib/question-loader.ts                                │
│                                                                     │
│  .eq('quality_status', 'active')                                    │
│                                                                     │
│  Only 'active' questions reach students.                            │
│  'pending' = invisible. 'flagged' = excluded + protected.           │
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
|-------|------|-------|---------|
| Pre-pipeline | PDF → Markdown (vision, per slide) | Sonnet | `pipeline-run` |
| Pre-pipeline | Teaching-content classifier, gates each slide before transcription (default on; `--exclusion-pass off` skips it) | A Google model, a different vendor from the transcriber | `pipeline-run` |
| Pre-pipeline | Topic extraction | Sonnet | `content-suggest-topics` |
| Pre-pipeline | Topic similarity and deduplication | Haiku | `content-suggest-topics` |
| 1 - Generation | MCQ/T-F (beginner/intermediate) | Haiku | `questions-generate` |
| 1 - Generation | Typed answers (beginner/intermediate) | Sonnet | `questions-generate` |
| 1 - Generation | All types (advanced) | Sonnet | `questions-generate` |
| 2 - Validation | Answer + grammar + difficulty check | Sonnet | `questions-generate` |
| 3 - Audit & Remediation | Default auditor | Mistral Large | `questions-audit` |
| 3 - Audit & Remediation | Sonnet auditor (`--auditor sonnet`) | Sonnet | `questions-audit` |
| Runtime | Answer evaluation, semantic tier | Opus | `api/evaluate-writing/route.ts` |

Model names here are families. The exact OpenRouter slug for each row is the `MODELS` constant in `packages/shared/src/models.ts`, which is authoritative.

### Why different models per stage?

- **Generation**: structured types (MCQ/T-F) go to the smaller, cheaper model. Typed answers and advanced difficulty go to the larger one, where calibration matters.
- **Validation**: the larger model catches grammar and answer errors from both generators. It runs in-process, so it adds no separate invocation.
- **Audit**: Mistral Large is the default auditor because it is independent of the generation vendor: it cannot share blind spots with the Claude-based generator and validator. The Sonnet auditor stays available through `--auditor sonnet` for comparison runs.

### Why Mistral is the default auditor

The February 2026 comparison behind this choice is summarized in
[evaluation-findings.md](evaluation-findings.md#earlier-sonnet-as-an-alternative-auditor-february-2026).

- **Provider independence.** Sonnet already runs in Stage 2. Using it again in Stage 3 would let both safety nets share the same blind spots.
- **More criteria.** `natural_language` and `register_appropriate` catch quality issues the Sonnet auditor does not evaluate.

### Gate and soft signals

The 6-criteria gate is the four core criteria plus `natural_language` and `register_appropriate`. The rest are soft signals.

| Criterion | Gate? | Rationale |
|-----------|-------|-----------|
| `answer_correct` | Yes | A wrong answer teaches the wrong material |
| `grammar_correct` | Yes | A grammar error teaches incorrect usage |
| `no_hallucination` | Yes | Fabricated content is harmful |
| `question_coherent` | Yes | Unanswerable questions frustrate students |
| `natural_language` | Yes | Unnatural phrasing affects learning |
| `register_appropriate` | Yes | Register errors teach wrong usage |
| `difficulty_appropriate` | No | Too noisy to gate on; applied as relabeling instead |
| `variations_valid` | No | Invalid variations are removed as remediation; missing ones are stored in metadata |
| `culturally_appropriate` | No | Flags stereotyping, cultural clustering, and stereotypical name-nationality pairings; logged in `audit_metadata`, no remediation applied |

### Audit grounding and gate scope

Both auditors receive the same course material each question's topic was generated from
(`buildAuditMaterialsBlock` in `learning-materials.ts`), grouped by distinct `(unit, topic)` pair and
truncated per topic (`AUDIT_MATERIAL_CHARS_PER_TOPIC`) so a group spanning several large topics stays
a reasonable prompt size. Without it, an auditor has no way to distinguish a real error from taught
content it has not seen: informal register, regional vocabulary, and colloquial dialogue the material
teaches are treated as correct, not flagged as errors.

The material's authority is scoped to language, not facts. Both prompts state that vocabulary,
expressions, and register the material teaches are in scope, but a statistic, date, or
historical/cultural claim is judged on its own accuracy regardless of what the material says. This
includes warm-up and discussion "answers" in course markdown, which are frequently a sample student
answer rather than a verified fact.

None of the 6 gate criteria (Mistral) or 4 gate criteria (Sonnet) judge whether a question's
difficulty matches its label. That belongs only to Mistral's `difficulty_appropriate` soft signal.
`register_appropriate` judges whether the French's register is internally consistent and
situationally appropriate, never whether it is too advanced or too informal for the stated level.

For multiple-choice, both auditors compare `correct_answer` against the options by exact text
rather than by re-deriving a lettered position: the stored answer already matches one option's text
verbatim, and the letters shown in the prompt are a reading aid, not stored data.

### Preflight

`auditHeadingPreflight` runs two gates before any model call, both exiting non-zero and naming the
problem:

1. **Stale headings.** The same check `questions-generate.ts` runs: every topic with stored headings,
   for every unit referenced by the audited questions, must have those headings resolve against the
   unit's current markdown.
2. **Unresolved material.** Gate 1 only inspects topics that already have stored headings. Gate 2
   confirms every audited question's `(unit, topic)` pair resolves to non-empty content via
   `extractTopicContent`, which catches what gate 1 cannot see: a topic with no stored headings whose
   name-substring fallback also fails to match anything, and an unknown unit or topic. Without this
   gate, those cases would fall through to `buildAuditMaterialsBlock`'s
   `(no source material found for this topic)` placeholder instead of failing the run.

`--allow-missing-material` skips gate 2 for an operator who has confirmed the gap and wants to audit
without reference material for the affected topics; it does not skip gate 1.

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
pipeline questions-audit --auditor sonnet --write-db --batch-id <batch-id>

# Re-audit a batch's active AND flagged questions (omit --pending-only). A question can flip
# either direction: active -> flagged on a newly caught error, or flagged -> active once a prompt
# fix (for example material grounding) clears a false positive
pipeline questions-audit --write-db --batch-id <batch-id>

# Generate every question type with one model (any OpenRouter slug; disables hybrid routing)
pipeline questions-generate --unit unit-2 --model mistralai/mistral-large-2512 --write-db
```

## Batch Audits (opt-in)

`questions-audit.ts`'s default `--auditor mistral` audits synchronously: one `callLlm` request per
question (`AUDIT_GROUP_SIZE` is 1; see the group-context workflow in the
[CLI guide](cli-guide-content-ingestion-and-question-pipeline.md#group-context-experiments-on-the-audit-task)
for why), in a loop with retry-on-429, applying each result to the database as soon as it completes
when `--write-db` is set. `--llm-batch` and `--llm-batch-resume` are a Mistral-only, opt-in
alternative that submits the same groups as a single OpenRouter batch job instead:

```bash
# Submit the audit as an OpenRouter batch instead of auditing synchronously
pipeline questions-audit --llm-batch --unit unit-3

# Poll a submitted job; combine with --write-db to apply results once the batch completes
pipeline questions-audit --llm-batch-resume <job-id> --write-db
```

Batch mode targets `MODELS.mistralAuditBatch` and the sync path targets `MODELS.mistralAudit`. Both
name the same Mistral Large model, so the two modes differ in price and turnaround, not in the
auditing model.

### `llm_batch_jobs`

Submitting a batch inserts one row into `llm_batch_jobs`, keyed by OpenRouter's `provider_batch_id`.
The row is the bookkeeping needed to resume later: `pipeline_batch_id` (the batch the audit run
belongs to), `custom_id_context` (maps each request's `custom_id` back to the question ids in that
group, so results can be applied without re-deriving the grouping), `status` and `request_counts`
(refreshed on each poll), and `is_fallback_applied`/`applied_at` (see below).

### Resume and apply-once semantics

`--llm-batch-resume <job-id>` polls the batch once. Without `--write-db` it only reports status
(still running, completed, or failed) and writes nothing to `questions`. With `--write-db`, a
completed batch's results are applied through the same `quality_status`/`audit_metadata` write logic
the sync path uses (`applyAuditResults`).

Applying is guarded by an atomic conditional claim (`UPDATE llm_batch_jobs SET applied_at = now()
WHERE applied_at IS NULL`): only the resume invocation that wins the claim applies results, so two
concurrent or retried resumes against the same job never double-apply. A group with no matching
result in the batch response, or a result whose `custom_id` matches no known group, is never given a
fabricated verdict. It is recorded on the job row's `error` column and left `pending` for a later
re-audit.

### Sync fallback on whole-batch failure

A batch can fail before any request in it executes (a malformed request among the group, an invalid
model), which OpenRouter reports as `status: 'failed'` with no per-request results, as opposed to an
ordinary terminal failure after execution began. Resuming such a job with `--write-db` falls back
automatically: each group in `custom_id_context` is re-run one at a time through the sync endpoint
(`MODELS.mistralAudit`, no retry loop), and the combined results are applied the same way a normal
batch's results would be. `is_fallback_applied` is set only once the fallback has run and its
results were applied. A preview-only resume (no `--write-db`) detects and records the failure but
leaves `is_fallback_applied` false, since nothing ran.

## Design Principles

### Stage independence

Each stage can be run, re-run, or swapped independently:

- **Re-audit without regenerating**: update audit prompts and re-run `questions-audit.ts` against existing questions. `--pending-only` limits a run to never-audited rows; omitting it re-audits a batch's `active` and `flagged` rows too and writes whichever verdict the new run reaches, so a question can move either direction, not just get promoted from pending.
- **Swap generators**: `--model <openrouter-slug>` uses one model for all of Stage 1 while Stages 2-3 stay unchanged.
- **Tune thresholds per stage**: validation rejects structurally broken questions; audit evaluates content quality. Different concerns, different prompts.

### Safety net layering

```
Generator errors caught by:   Validation (Stage 2) → Audit & Remediation (Stage 3)
Validation errors caught by:  Audit & Remediation (Stage 3)
Audit errors caught by:       Cross-validation (Mistral vs Sonnet comparison)
Remediation errors caught by: Evaluation fallback tiers (fuzzy match → semantic LLM call)
```

No single model failure can put bad questions in front of students. The `pending` quality gate keeps questions invisible until they are explicitly promoted.

### Parser strictness

A missing or malformed model response is never treated as a pass. Validation (Stage 2) and audit
(Stage 3, both Mistral and Sonnet) match each response to its question by the `id` the prompt
requires the model to echo back, never by array position: a short, reordered, or malformed
response cannot silently validate or activate the wrong question. A question a parseable response
never returned a result for stays pending (validation: counted as `validation_unmatched`; audit: a
per-question `PARSE_ERROR` note). A whole group whose response fails to parse rejects every
question in it (validation: `validation_errors`; audit: a per-question `PARSE_ERROR`/`API_ERROR`
passthrough) rather than passing the group through. Soft signals (audit's `difficulty_appropriate`,
`variations_valid`, `culturally_appropriate`) are informational and still default when absent;
only the gate criteria that decide `active` vs `flagged` are held to this strictness.

### Usage and cost tracking

Every OpenRouter call's `usage` object (tokens, cost, served model, BYOK routing) is parsed by
`callLlm` (`packages/shared/src/llm.ts`) into a typed `LlmResult.usage`, and each task that calls
it records what it spent:

- **Generation and validation**: accumulated per stage (`calls`, `prompt_tokens`,
  `completion_tokens`, `reasoning_tokens`, `cost_usd`, `byok_calls`, `json_failures`) and written to
  `batches.quality_metrics.llm_usage.{generation,validation}`.
- **Audit** (Mistral and Sonnet, sync and `--llm-batch-resume`): each question's `audit_metadata`
  carries its share of the call's usage (Mistral divides a group's usage evenly across the
  questions it audited; Sonnet audits one question per call, so there is nothing to divide) and the
  served model. `llm_batch_jobs.total_cost_usd` holds the sum for a completed batch job.
- **PDF conversion**: each slide's `.conversion-report.json` entry under `slideUsage` records that
  slide's usage (absent for a slide served from the on-disk transcription cache, since no call was
  made), and `totalUsage` sums it.
- **Topic extraction and `--map-existing`**: printed as a one-line summary at the end of the run.
- **Student answer grading**: cost, served model, and token counts are added to the structured
  `Evaluation complete` log line, never to any response the student's browser receives.

Every command that made at least one call prints `Usage: N calls, X prompt / Y completion tokens,
$Z` once at the end of the run (`apps/pipeline/src/lib/usage-tracking.ts`).

### Question count

`questions-generate.ts` sizes each topic/difficulty's question count to that topic's extracted
content rather than using one fixed number: `computeQuestionCap()` in
`apps/pipeline/src/lib/pipeline-config.ts` gives roughly one question per 150 characters, clamped to
2-10. `--count` overrides the cap for the whole run. The generation prompt asks for "up to" that
count: a topic with little material returning fewer questions than the cap is expected, not an
error, and is not retried.

### Grounding vs. correctness

The generation prompt's Reference Materials define scope: which vocabulary, grammar, and cultural
topics are fair game, not a transcript to reproduce uncritically. The French and the facts in every
question, answer, and acceptable variation must be correct independently of the source material, so
a slide's own error, an imprecise statement, or a student's wrong sample answer gets skipped or
corrected rather than tested as true.

## Data Hygiene via Cascade Deletes

The student and question tables use `ON DELETE CASCADE`, so deleting a parent record cleans up its
dependent data without manual steps.

### Production chains

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

These chains are independent. Deleting a batch does not affect student data, and deleting a student
does not affect questions. `llm_batch_jobs.pipeline_batch_id` points at a batch by convention only,
with no foreign key.

### Evaluation tables

The evaluation tables follow a different rule. Deleting an `eval_sets` row cascades to its items,
runs, and results. The durable layer is not cascaded: an `eval_review_rounds` row blocks deletion of
its set (`ON DELETE RESTRICT`), and the references from a run or finding to an experiment, a model
snapshot, or an earlier finding have no delete action, so removing one of those while it is still
referenced fails.

## Audit Metadata

When `--write-db` is set, Stage 3 writes an `audit_metadata` JSONB column alongside `quality_status`. This persists the full diagnostic snapshot for each question.

### Schema

```jsonc
{
  "auditor": "mistral",              // or "sonnet"
  "model": "mistralai/mistral-large-2512", // exact model ID used
  "audited_at": "<ISO timestamp>",
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
  "usage": {                         // this question's share of its audit call's usage: the
                                     // call's cost and tokens divided evenly across every
                                     // question in its group; null if the call carried no usage
    "prompt_tokens": 620,
    "completion_tokens": 210,
    "reasoning_tokens": null,
    "cost_usd": 0.0009
  },
  "served_model": "mistralai/mistral-large-2512", // the model OpenRouter reports served
  "prompt_hash": "a1b2c3d4e5f6a7b8"  // sha256 (16 hex) of the rendered audit system prompt
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

**Difficulty relabeling**: Stage 2 (Sonnet validation) does a first-pass difficulty check. Stage 3 (Mistral audit) re-assesses it. The `audit_metadata` records the audit's finding (`suggested_difficulty`), and the `difficulty` column is updated to match.

**Variation removal** (subtractive only): invalid variations identified by Mistral are removed from `acceptable_variations` on passing questions. This is safe because removal's worst case (rejecting a correct answer) is caught by the semantic LLM tier, which grades every answer the string-matching tiers do not accept, while leaving invalid variations in place would silently accept wrong answers with no safety net. `missing_variations` are stored in `audit_metadata` but not applied: adding variations is an additive content modification with no fallback safety net.

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

Results and conclusions are in [evaluation-findings.md](evaluation-findings.md); this section covers
mechanics only.

A separate set of tables and commands tests whether a different model, provider, or setting holds
up on a given task before it is adopted, without touching production questions. The commands are
`eval-set-create`, `eval-seed-grading`, `eval-review-export`, `eval-review-import`,
`eval-experiment-create`, `eval-run`, `eval-compare`, `eval-rescore`, `eval-finding`, and
`eval-judge`. See [`apps/pipeline/README.md`](../apps/pipeline/README.md) for command behavior and
flags, and the [CLI guide](cli-guide-content-ingestion-and-question-pipeline.md#10-workflow-evaluating-models)
for the workflow. The audit, grading, mapping, and transcription tasks have runners; generation and
validation share the same tables but have none.

The task tables, service-role only, no anon policies:

- **`eval_sets`**: one frozen item sample. Records which task it is for, where it was drawn from
  (`source`, a batch id or similar), how it was sampled (`selection`: strata, seed, filters), and a
  hash of the inputs the items depend on (`inputs_hash`: the touched units' markdown and rows), so
  reusing a set later can detect that the underlying material has changed.
- **`eval_items`**: one row per item in a set, holding a frozen snapshot of its input (`payload`)
  and an optional reviewer-assigned label (`reference`). `reference_status` (`pending` / `approved` /
  `rejected`) tracks review state independently of whether `reference` is populated yet.
- **`eval_runs`**: one variant, one execution against a set. Records the model, the call settings,
  the experiment it is attributed to (if any), and a `summary` JSONB computed once every item has a
  result. `scored_at` and `scoring_review_round_id` are the scoring provenance for that summary: when
  it was last computed (at finalization or by a later `eval-rescore`) and the newest
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
  group, since it describes the whole call, not a per-question share.

  A transcription row gains a `classifier` key holding the same fields for its exclusion-pass
  classifier call (plus that call's served model and provider) when `--exclusion-pass` ran. A
  transcription `response_meta` is one of four shapes: null (no call returned a response), top-level
  fields only (no exclusion pass ran), top-level plus `classifier` (both calls returned a response),
  or `classifier` alone, which means the transcription call returned nothing to record. The last
  case is told apart by the row's `error` and `deterministic_checks.exclusion_decision`: the
  classifier dropped the slide (no error, decision `drop`, no transcription call made), the
  transcription call failed after the classifier kept the slide (`api` or `empty`, decision `keep`),
  or the classifier's own response did not parse (`parse`, decision null).

### Items and reference by task

For the audit task, `eval_items.payload` snapshots a question's fields plus the production
auditor's own verdict (`production_audit`), for a production-verdict comparison when approved
reference is not available yet. Approved audit reference is the six gate criteria as booleans (the
same shape `audit_metadata.gate_criteria` uses) plus a reviewer `borderline` flag and `reason`.

For the grading task, one item exists per (question, label class) pair, where the label classes are
`correct`, `wrong`, `typo`, `missing_accent`, `valid_paraphrase`, and `partially_correct`. Approved
grading reference is the reviewer's own `isCorrect`/`borderline`/`reason` verdict on the item's
`submitted_answer`, not a score. Grading's summary also carries `byDesignLabel`, a marked-correct
rate per seeded label class computed from the model's own verdict alone, independent of reviewed
reference. It is available the moment a run finishes, unlike `byLabel`, which needs an approved
reference and reads `n: 0` until one exists.

For the mapping task, one item exists per topic of a unit (`eval_items.payload` is
`{ unit_id, topic }`). Unlike audit and grading, reference is written at `eval-set-create` time, not
by a reviewer: it is the unit's own current, already-validated headings for that topic, normalized to
`{ heading, slide }` form, and `reference_status` is `approved` immediately. `eval_results.score`
holds the per-topic heading-set F1 against that reference; `deterministic_checks` holds the count of
returned headings that resolve in the document, the count that do not (with which ones), and the
count covered by another heading in the same call's response (a nested duplicate, before any
collapse).

For the transcription task, one item exists per slide drawn from three categories: image-dominated
and text slides straight from a `*.conversion-report.json`, plus a "mixed" category derived from
text-layer length that production does not track itself (see `categorizeTranscriptionSlides` in
`apps/pipeline/src/lib/eval/set-builder.ts`). `eval_items.payload` freezes the slide's own
`pdftotext` text layer (`{ pdf_name, slide, category, text_layer, production_flagged }`). Reference
is a checked transcript, reviewed after the fact like audit and grading, through one `<slide>.md`
file per item rather than a spreadsheet, since a transcript is reviewed against the slide image.
`eval_results.score` holds `1 - normalized edit distance` against reference (`scoreTranscription` in
`apps/pipeline/src/lib/eval/transcription-scoring.ts`); `deterministic_checks` holds the slide's
text coverage, whether the output is exactly the no-content marker, and the widest markdown table's
row and column counts.

### Parity with production

`eval-run` calls the exact production prompt builder and parser for each task (the audit prompt
shared with `questions-audit.ts`, the grading prompt shared with `evaluate-writing`'s route, the
mapping prompt and parser shared with `content-suggest-topics --map-existing`, the transcription
prompt and slide renderer shared with `pdf-conversion.ts`) with the model and settings under test
injected, rather than a copy that could drift from what production sends. The grading prompt is a system message holding the rubric and a user message holding the question, expected answer and student answer in tags; the grading task also derives `isCorrect` from the score and the pass threshold, as the route does. One call covers every
topic in a mapping set at once, matching the production prompt, so a mapping run is one call per
variant per repeat. Transcription stays one call per slide but renders each slide's image once per
invocation and reuses it across every variant and repeat. It never reads the production slide
cache: every kept slide is sent to the model on every call, since a cached transcript would record
zero cost and make repeats of a baseline identical by construction, which is not the noise floor
being measured.

### Comparison and rescoring

`eval-compare` pairs a candidate run against a baseline on their shared, reference-approved items.
Audit, grading, and transcription get a non-inferiority verdict against a per-task tolerance
(`TASK_TOLERANCES` in `apps/pipeline/src/lib/eval/tolerances.ts`); transcription's verdict runs on
words captured rather than character similarity. Mapping gets a paired continuous-metric comparison
(mean difference plus an exact sign test) and no verdict. A transcription set with no approved
reference falls back to a reference-free report of agreement between each candidate's and the
baseline's own transcript, which is not an accuracy figure. The comparison is written back into
`eval_runs.summary.compare`; recording a decision is a separate step that writes `eval_findings`.

`eval-rescore` recomputes a completed run's per-item scores and `summary` from what is already
stored, with no model call. `outcomeFromStoredResult` (one function per task in
`lib/eval/tasks/*.ts`) rebuilds the outcome `eval-run`'s own `runCall` would have produced from the
stored `eval_results` and `eval_items` rows alone, so a rescore and a fresh run share one code path.
This is what fills in a run whose `metric_status` reads "scored before references existed" below.
Per-item `score` is touched only for transcription and mapping, the two tasks scored against a
reference.

### Judge verdicts

`eval-judge` is a reference-free alternative to `eval-compare` for transcription. A third model
looks at the slide image and the two runs' transcripts and picks the more complete and faithful one.
Every shared item is judged twice with the two runs' positions swapped, and a run wins the item only
when it wins in both orders, which cancels the judge's position bias.

With `--write-db`, each judged item's `eval_results.judge_verdict` gains an entry, keyed first by the
other run's id and then by the judge prompt hash that produced it. Every invocation appends, so the
same pair can be judged again under the same prompt, by the same judge model or another, with every
earlier entry kept; that is what lets the judge's own run-to-run noise be measured. Each entry
carries a `repeat` index (the count of earlier entries from the same judge model), the call settings
the command sent (`judge_call`: the provider pin or null, reasoning off, no temperature set), and
the response facts of both position-order calls (`calls`: response id, finish reason, the model and
host OpenRouter says served each call; never message content). `judge_model` and
`judge_prompt_hash` on the two `eval_runs` rows describe the latest judge call on the run, not any
one pairing.

### The durable layer: experiments, model registry, findings

More tables sit above the task tables, recording the parts of an evaluation program that outlive
any single run, all service-role only with no anon policies:

- **`eval_experiments`**: one named question under test (for example, whether a cheaper vision model
  transcribes slides as well as production), identified by a descriptive `slug`, its declared
  variants, and the decision rule it will be judged against (a task's default tolerance, or an
  override for this experiment only). `eval-run --experiment <id-or-slug>` attributes runs to it;
  its `status` moves through `proposed`, `running`, and then `decided`, `deferred`, or `superseded`.
  `eval-experiment-create` is the only command that creates or edits the row, and it validates what
  it writes against the registry and the tolerance keys.
- **`eval_model_families`** / **`eval_models`**: a dated snapshot of a model's attributes (open or
  closed weights, total and active parameter count, architecture, release date, price, context
  window, reasoning support, and known serving hosts), one row per model identifier per
  `effective_date`. Append-only except for `notes` and `family_id`, enforced by a trigger: a
  correction to either of those is a normal update, but a correction to any other attribute (a
  wrong price, a wrong context window) is a new dated row at a new `effective_date`, the same as a
  routine catalog refresh, since a model identifier can silently repoint to different underlying
  weights or pricing later. `eval_models_current` is the latest snapshot per identifier; `eval-run`
  resolves `--models` against it before starting and refuses the whole invocation if a model has no
  row there. `eval_model_families` groups snapshots into a lineage (every release of the same model
  line) so a query can trace one family's trend across versions independent of identifier changes.
  The registry starts empty; see "Registering a model" in the CLI guide.
- **`eval_findings`**: an append-only record of what was concluded and why, each row citing the run
  and item ids that support it. A finding is `adopt`, `reject`, `defer`, or a plain `observation`; a
  later reversal writes a new row with `supersedes_finding_id` pointing at the one it revises, rather
  than editing the original. `eval-compare --decide` writes an adopt, reject, or defer finding and
  moves the experiment's status; `eval-finding` writes a plain `observation` and never touches it.
- **`eval_review_rounds`**: one row per reference-labeling campaign on a set (who reviewed it, under
  what rubric version, with what calibration result against a pilot sample), kept separate from
  `eval_items.reviewed_by`/`reviewed_at`, which are per item. A re-review under a revised rubric adds
  a new round rather than overwriting the claim about what confidence applied under the old one.

### Two-pass review import

A set whose owner can revise a reviewer's mark (the owner has access to the course material the
reviewer does not, or applies rubric scope the reviewer missed) is imported in two
`eval-review-import` passes against the same set, in this order:

1. **Owner pass.** A workbook holding only the items the owner revised or filled is imported under a
   reviewer handle of the form `<reviewer>+owner` (for example `sandra-o+owner`), without
   `--policy-labels`.
2. **Reviewer pass.** The reviewer's full workbook is imported under the reviewer's own handle.
   Items the owner pass already approved are skipped by default (`--overwrite` is not passed), so
   `eval_items.reviewed_by` on each item ends up naming whichever pass actually set its reference.
   `--policy-labels` runs only on this pass, so policy-approved `typo`/`missing_accent` items are
   stamped `reviewed_by: 'policy'`, never the owner handle.

Each pass records its own `eval_review_rounds` row, so a set reviewed this way carries two rounds,
not one. A sensitivity check that wants to exclude owner-revised items from a result filters
`eval_items.reviewed_by` for the `+owner` handle.

The owner revises a reviewer's mark only under rules recorded per item, outside the sheet's mark
columns: the course material settles the mark the other way and the reviewer has no access to it;
the mark rests on something the rubric puts out of scope (acceptable variations, distractors,
typography, punctuation); the reviewer's own standard applied consistently to a blank or
inconsistent cell; or sheet logic (an answer identical to an unchallenged key). A question the owner
judges defective is excluded whole, its rows dropped from both workbooks, rather than having its key
dispute resolved; its items stay `pending`.

The two import workbooks are built from a review copy of the reviewer's workbook that carries one
added column, `evaluation_notes`, the only column edited during review. Each decision in that column
ends with an `APPLY:` clause naming either column=value pairs or `exclude row`; a script turns those
clauses into the owner and reviewer workbooks above, so the reviewer's original file is never
modified directly. `eval-review-import` itself validates every row before any write and refuses the
whole tab on any error, including a blank verdict cell.

### Views

Views compute across the tables so a comparison does not need a hand-written join each time. Each
view's `COMMENT ON VIEW` in `supabase/schema.sql` is its authoritative description.

| View | One row per | Use |
|------|-------------|-----|
| `eval_models_current` | model slug | Latest snapshot; what `eval-run` resolves `--models` against when stamping `model_version_id` |
| `eval_run_scorecard` | run | Run with its model's registry attributes, experiment slug, `scored_at`, and `scoring_review_round_id` joined in |
| `eval_model_history` | run, ordered by model identifier and time | Tracking one model across runs |
| `eval_run_model_stats` | run | Mean cost, mean latency, error count, provider-pin mismatch count, and a cost-per-metric-unit ratio, joined to registry attributes |
| `eval_family_history` | run, ordered by model family and effective date | Tracking a lineage across version changes |
| `eval_item_consensus` | item with at least two completed, non-error runs | How many runs agree on the item's verdict; the human-review worklist, ordered by `majority_share` |
| `eval_run_behaviour` | completed run | Reference-free result and error counts, parse-failure rate, mean cost, latency p50/p95, and a `task_behaviour` column; ranks audit and grading variants while references are pending |
| `eval_variant_stability` | variant identity | Run count, the metric's mean and spread, mean cost, and run ids; identity is experiment, set, model, prompt hash, and the caller-chosen settings, never `variant_label` |
| `eval_experiment_variants` | declared variant | The runs matching the declaration, with an `ambiguous` flag when another declared variant matches the same runs |
| `eval_experiment_dependencies` | `depends_on` entry | The dependency's current status, or `missing` |
| `eval_experiment_summary` | experiment | Run count, finding counts, how many declared variants have matched a run, and how many dependencies are undecided |
| `eval_findings_current` | superseded chain | The findings feed with each chain collapsed to its most recent entry |
| `eval_run_pair_agreement` | unordered pair of completed runs on one set | Items both scored without error and the share where they reached the same verdict; comparable only within one `verdict_kind` |
| `eval_overview` | the whole layer | Header counts: every table's size, runs and experiments by status, findings by kind, registered models |
| `eval_reference_status_by_task` | task and reference status | Items and sets per status |
| `eval_provider_coverage` | task | How many results never recorded a serving host, plus pin and mismatch counts |
| `eval_metric_status_by_task` | task and metric status | Runs per status |
| `eval_run_snapshot_status` | run | Whether the model snapshot the run resolved at start is still the current one for its slug |

Three notes on how the views behave:

- **Variant matching.** `eval_experiment_variants` matches a declared variant to runs by model slug
  and, for every settings key the declaration carries, the run's own normalized settings, as
  `declaredVariantMatchesRun` does in TypeScript. The normalization is the same one
  `normalizeRepeatIdentitySettings` in `apps/pipeline/src/commands/eval-run.ts` applies, and
  `eval_variant_stability` uses it too. A run that carries no `mode` or `grouping` counts as `sync`
  and `by_order`, since `eval-run` writes neither. A declaration whose `model_slug` is `'*'` or null
  matches no run by design. A declaration may carry `baseline_from`, the slug of another experiment
  whose runs it draws on, and the view then reports that slug as `runs_from_slug`.
- **Provider pins.** Provider-pin mismatch is compared through `eval_normalize_provider(name,
  is_pin)`, a SQL mirror of `normalizeProviderName`/`normalizePin` in
  `apps/pipeline/src/lib/eval/compare/shared.ts` (lowercase, strip non-alphanumerics, and for a pin
  drop everything after the first `/`), so a hand-typed `--provider anthropic` is not flagged
  against OpenRouter's own `Anthropic`.
- **Verdicts.** The per-task verdict that `eval_item_consensus` and `eval_run_pair_agreement`
  compare (grading's `isCorrect`, audit's six gate criteria, mapping's heading set, transcription's
  no-content-marker decision) lives in one function, `eval_result_verdict(task, output,
  deterministic_checks)`, so the two views cannot drift apart on what a verdict means. For
  transcription, agreement measures the no-content marker, not how alike two transcripts are.

Three run views, `eval_run_scorecard`, `eval_run_model_stats` and `eval_run_behaviour`, carry
`metric_status` (`eval_family_history` passes through `eval_run_model_stats`'s), which explains a
null `primary_metric`/`primary_metric_value`. It is checked in this order:

1. `failed run`: the run itself did not complete.
2. `reference reviewed after scoring`: a metric is present, but either the run's `scored_at`
   predates the newest `reviewed_at` among the set's approved items, or an `eval_review_rounds` row
   on the set is newer than the one the run was scored against (including any round at all when the
   run was scored against none). A reviewer changed a reference since this summary was computed, and
   `eval-rescore` would likely change it.
3. `ok`: a metric is present and neither of those holds.
4. `awaiting reviewed references`: the run's set has no approved reference item yet.
5. `scored before references existed`: the run's `scored_at`, or its `finished_at` for a run from
   before that column existed, is earlier than the set's earliest approved item's `reviewed_at`.
   Re-running `eval-rescore` fills the metric in.
6. `no primary metric`: none of the above explains it, so it is worth investigating.

With as few repeats as most of these evaluations run, treat any apparent link between a score and a
specific model attribute (parameter count, architecture, reasoning support) as a hypothesis to check
with a larger sample, not a settled finding.
