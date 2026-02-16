# Question Generation Pipeline Architecture

## Overview

Questions go through three independent stages before reaching students. Each stage has a distinct responsibility and can be run, tuned, or swapped independently.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CONTENT SOURCES                              │
│  PDF/  ──→ data/markdown/  ──→ src/lib/units.ts (topics)           │
│  (Sonnet 4)   (Sonnet 4)        (Sonnet 4)                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 1: GENERATION                                                │
│  scripts/generate-questions.ts                                      │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ Beginner/Int │    │   Advanced   │    │   --model override   │  │
│  │  MCQ / T-F   │    │  All types   │    │  (e.g. Mistral)      │  │
│  │  Haiku 4.5   │    │  Sonnet 4.5  │    │  Any supported model │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘  │
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
│  scripts/generate-questions.ts → validateAnswers()                  │
│  Model: Sonnet 4.5                                                  │
│                                                                     │
│  For each batch of ~5 questions:                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1. Answer correctness — is the answer factually right?      │   │
│  │ 2. Grammar check — correct French in question + answer?     │   │
│  │ 3. Difficulty re-labeling — does label match cognitive       │   │
│  │    demand? (beginner/intermediate/advanced)                  │   │
│  │ 4. Acceptable variations — 2-3 alternate answers for        │   │
│  │    typed-answer questions                                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  Outcomes:                                                          │
│    PASS → insert to DB as quality_status = 'pending'               │
│    FAIL → rejected, logged, not inserted                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 3: AUDIT & REMEDIATION           (separate process)          │
│  Default: audit-quality-mistral.ts      Model: Mistral Large        │
│  Override: audit-quality.ts (--auditor sonnet)  Model: Sonnet 4.5   │
│                                                                     │
│  Gate criteria (6 — all must pass for 'active'):                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 1. answer_correct — is the answer right?                    │   │
│  │ 2. grammar_correct — is the French correct?                 │   │
│  │ 3. no_hallucination — is the content grounded?              │   │
│  │ 4. question_coherent — does the question make sense?        │   │
│  │ 5. natural_french — does the French sound natural?          │   │
│  │ 6. register_appropriate — is formality level correct?       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Soft signals (logged, not gated):                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ 7. difficulty_appropriate — is difficulty label correct?     │   │
│  │ 8. variations_valid — are acceptable variations correct?    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│  Note: Sonnet audit evaluates criteria 1-4 only (no remediation).   │
│                                                                     │
│  Writes to DB (--write-db):                                        │
│    audit_metadata JSONB — full diagnostic snapshot per question     │
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
│  src/lib/question-loader.ts                                         │
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
| `pending` | No | Yes | Inserted by generation after passing validation |
| `active` | Yes | Yes | Promoted by audit (all gate criteria pass) |
| `flagged` | No | Yes (via batch cascade) | Demoted by audit (any gate criterion fails) |

## Model Assignments

| Stage | Task | Model | Script |
|-------|------|-------|--------|
| Pre-pipeline | PDF → Markdown | Sonnet 4 | `regenerate.ts` |
| Pre-pipeline | Topic extraction | Sonnet 4 | `suggest-unit-topics.ts` |
| 1 - Generation | MCQ/T-F (beginner/intermediate) | Haiku 4.5 | `generate-questions.ts` |
| 1 - Generation | Typed answers (beginner/intermediate) | Sonnet 4.5 | `generate-questions.ts` |
| 1 - Generation | All types (advanced) | Sonnet 4.5 | `generate-questions.ts` |
| 2 - Validation | Answer + grammar + difficulty check | Sonnet 4.5 | `generate-questions.ts` |
| 3 - Audit & Remediation | Default auditor | Mistral Large | `audit-quality-mistral.ts` |
| 3 - Audit & Remediation | Sonnet auditor (override) | Sonnet 4.5 | `audit-quality.ts` |
| Runtime | Answer evaluation | Opus 4.6 | `api/evaluate-writing/route.ts` |

### Why different models per stage?

- **Generation**: Haiku for structured types (MCQ/T-F) is 10x cheaper than Sonnet with comparable quality. Sonnet handles typed answers and advanced difficulty where calibration matters.
- **Validation**: Sonnet catches grammar/answer errors from both Haiku and Sonnet generation. Acts as a safety net at zero additional prompt cost (runs in the same script).
- **Audit**: Mistral Large is the default auditor because it provides genuine provider independence — it can't share blind spots with the Claude-based generator and validator. Cross-validation showed Mistral caught 476 issues Sonnet missed (14:1 blind spot ratio). Sonnet remains available via `--auditor sonnet` for comparison runs.

## CLI Commands

### Individual stages

```bash
# Stage 1+2: Generate + validate (inserts as 'pending')
npx tsx scripts/generate-questions.ts --unit unit-3 --write-db

# Stage 3: Audit pending questions with Mistral (default, promotes to active/flagged)
npx tsx scripts/audit-quality-mistral.ts --write-db --pending-only

# Stage 3: Audit with Sonnet instead
npx tsx scripts/audit-quality.ts --write-db --pending-only
```

### Full pipeline

```bash
# All stages chained: PDF → Markdown → Topics → Generation → Audit (Mistral default)
npx tsx scripts/regenerate.ts unit-3 --write-db --audit

# Use Sonnet for audit instead
npx tsx scripts/regenerate.ts unit-3 --write-db --audit --auditor sonnet

# Dry run (shows what would happen without API calls)
npx tsx scripts/regenerate.ts unit-3 --write-db --audit --dry-run
```

### Targeted operations

```bash
# Generate only fill-in-blank, advanced difficulty
npx tsx scripts/generate-questions.ts --unit unit-2 --type fill-in-blank --difficulty advanced --write-db

# Audit only questions from a specific batch
npx tsx scripts/audit-quality.ts --write-db --batch batch_2026-02-13_abc

# Generate with Mistral (experimental)
npx tsx scripts/generate-questions.ts --unit unit-2 --model mistral-large-latest --write-db
```

## Design Principles

### Stage independence

Each stage can be run, re-run, or swapped independently:

- **Re-audit without regenerating**: Update audit prompts and re-run `audit-quality.ts` against existing questions
- **Swap generators**: `--model mistral-large-latest` uses Mistral for Stage 1 while Stages 2-3 remain unchanged (see [Mistral experiment](mistral-generation-experiment.md))
- **Tune thresholds per stage**: Validation rejects structurally broken questions; audit evaluates content quality — different concerns, different prompts

### Safety net layering

```
Generator errors caught by:   Validation (Stage 2) → Audit & Remediation (Stage 3)
Validation errors caught by:  Audit & Remediation (Stage 3)
Audit errors caught by:       Cross-validation (Mistral vs Sonnet comparison)
Remediation errors caught by: Evaluation fallback tiers (fuzzy → Opus API)
```

No single model failure can put bad questions in front of students. The `pending` quality gate ensures questions are invisible until explicitly promoted.

### Cost optimization

The hybrid model split routes cheap structured types (MCQ, T-F) to Haiku and expensive typed answers (fill-in-blank, writing) to Sonnet. Advanced difficulty always uses Sonnet regardless of type, since Haiku showed 80%+ difficulty miscalibration at that level.

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

These chains are independent — deleting a batch does not affect student data, and deleting a student does not affect questions.

### Experiment chain

```
experiments → experiment_batches → experiment_questions
experiments → experiment_questions (direct FK)
```

Fully isolated from production tables.

## File Map

```
scripts/
├── regenerate.ts                 # Pipeline orchestrator (Steps 1-4)
├── generate-questions.ts         # Stage 1 (generation) + Stage 2 (validation)
├── audit-quality-mistral.ts      # Stage 3 (default — Mistral audit & remediation, 6-criteria gate)
├── audit-quality.ts              # Stage 3 (Sonnet audit, 4-criteria gate, no remediation)
├── suggest-unit-topics.ts        # Pre-pipeline: topic discovery
├── plan-generation.ts            # Planning tool: estimate question counts/costs
└── lib/
    ├── config.ts                 # Model IDs, type classifications, cost estimates
    ├── writing-type-inference.ts # Writing subtype detection
    ├── topic-utils.ts            # Topic name normalization
    └── file-updaters.ts          # units.ts auto-update utilities

src/lib/
├── question-loader.ts            # Runtime: loads active questions for quizzes
├── units.ts                      # Unit definitions with topics + heading mappings
└── learning-materials.ts         # Loads markdown content for topic extraction

data/markdown/                    # Converted learning materials (Stage 0 output)
```

## Cross-Validation Findings (Sonnet vs Mistral)

Full-corpus cross-validation (1,039 questions, Feb 2026) informed the decision to make Mistral the default Stage 3 auditor.

### Agreement on Core 4 Criteria

| Criterion | Agreement | Sonnet-only fail | Mistral-only fail |
|-----------|-----------|------------------|-------------------|
| answer_correct | 91.2% | 44 | 47 |
| grammar_correct | 95.9% | 6 | 37 |
| no_hallucination | 91.9% | 76 | 8 |
| question_coherent | 95.4% | 36 | 12 |

### Why Mistral is the Default

- **476 blind spots Sonnet missed** vs 34 Sonnet-only findings (14:1 ratio)
- **Provider independence**: Sonnet already runs in Stage 2 (validation). Using it again in Stage 3 means both safety nets share the same blind spots.
- **Not overly strict**: Mistral's core-4 pass rates are higher than Sonnet's for 3 of 4 question types.
- **Additional criteria**: `natural_french` and `register_appropriate` checks catch quality issues Sonnet doesn't evaluate.

### Tiered Gate Design

The 6-criteria gate (core 4 + `natural_french` + `register_appropriate`) was chosen based on fail rate analysis:

| Criterion | Fail Rate | Gate? | Rationale |
|-----------|-----------|-------|-----------|
| answer_correct | ~6% | Yes | Wrong answers teach wrong French |
| grammar_correct | ~4% | Yes | Grammar errors teach wrong French |
| no_hallucination | ~5% | Yes | Fabricated content is harmful |
| question_coherent | ~2% | Yes | Unanswerable questions frustrate students |
| natural_french | 4.8% | Yes | Unnatural French affects learning |
| register_appropriate | 2.7% | Yes | Register errors teach wrong usage |
| difficulty_appropriate | 41.0% | No | Too noisy; applied as relabeling instead |
| variations_valid | 22.6% | No | Invalid variations removed as remediation; missing stored in metadata |

## Audit Metadata

When `--write-db` is set, Stage 3 writes an `audit_metadata` JSONB column alongside `quality_status`. This persists the full diagnostic snapshot for each question.

### Schema

```jsonc
{
  "auditor": "mistral",              // or "sonnet"
  "model": "mistral-large-latest",   // exact model ID used
  "audited_at": "2026-02-13T...",    // ISO timestamp
  "gate_criteria": {
    "answer_correct": true,
    "grammar_correct": true,
    "no_hallucination": true,
    "question_coherent": true,
    "natural_french": true,          // Mistral only
    "register_appropriate": true     // Mistral only
  },
  "soft_signals": {                  // Mistral only
    "difficulty_appropriate": false,
    "suggested_difficulty": "beginner",
    "variations_valid": false,
    "missing_variations": ["var1"],
    "invalid_variations": ["var2"]
  },
  "severity": "minor",
  "notes": "Difficulty mismatch: intermediate -> beginner"
}
```

### What Stage 3 mutates

| Field | Mistral | Sonnet | Condition |
|-------|---------|--------|-----------|
| `quality_status` | Yes | Yes | Always (gate pass/fail) |
| `audit_metadata` | Yes | Yes | Always (diagnostic snapshot) |
| `difficulty` | Yes | No | Only on gate pass, when `suggested_difficulty` differs |
| `acceptable_variations` | Yes | No | Only on gate pass, when `invalid_variations` found |

**Difficulty relabeling**: Stage 2 (Sonnet validation) does a first-pass difficulty check. Stage 3 (Mistral audit) corrects it with better calibration — cross-validation showed Mistral has significantly better difficulty assessment. The `audit_metadata` records the original finding (`suggested_difficulty`), and the `difficulty` column is updated to match.

**Variation removal** (subtractive only): Invalid variations identified by Mistral are removed from `acceptable_variations` on passing questions. This is safe because removal's worst case (rejecting a correct answer) is caught by the evaluation fallback tiers (fuzzy matching → Opus API), while leaving invalid variations in place would silently accept wrong answers with no safety net. `missing_variations` are stored in `audit_metadata` but not applied — adding variations is an additive content modification with no fallback safety net.

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

-- Audit pass rate by auditor
SELECT audit_metadata->>'auditor', quality_status, COUNT(*)
FROM questions WHERE audit_metadata IS NOT NULL
GROUP BY 1, 2;
```
