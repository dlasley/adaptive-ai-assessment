# Scripts Directory

## Quick Reference

Scripts are organized by prefix:

| Prefix | Purpose |
|--------|---------|
| `corpus-` | Production content pipeline (PDF → questions) |
| `audit-` | Quality evaluation and cross-validation |
| `experiment-` | A/B experiment framework |
| `db-` | Database utilities |

All scripts support `--help` / `-h`.

---

## Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      corpus-generate.ts                          │
│  (orchestrator — runs the full pipeline for a unit)              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
       ┌───────────────────────┼───────────────────────┐
       ▼                       ▼                       ▼
  PDF files             Markdown files          Topic extraction
  (PDF/)                (learnings/)
       │                       │                       │
       └──────────┬────────────┘                       │
                  ▼                                    │
        corpus-suggest-topics.ts ◄─────────────────────┘
        (extracts teachable topics)
                  │
                  ▼
        corpus-generate-questions.ts
        (creates questions via AI — Stage 1+2)
                  │
                  ▼
        audit-mistral.ts / audit-sonnet.ts
        (quality gate — Stage 3)
                  │
                  ▼
            Supabase DB
            (questions table)
```

---

## Script Reference

### corpus-generate.ts

Full pipeline orchestrator: PDF → Markdown → Topics → Questions → Audit.

```bash
npx tsx scripts/corpus-generate.ts <unit-id> [options]
npx tsx scripts/corpus-generate.ts --unit <unit-id> [options]
npx tsx scripts/corpus-generate.ts --all [options]

Options:
  --unit <unit-id>          Unit to process (alternative to positional arg)
  --write-db                Sync generated questions to database
  --audit                   Run quality audit after generation (requires --write-db)
  --auditor <m>             Audit model: 'mistral' (default) or 'sonnet'
  --skip-convert            Skip PDF conversion (use existing markdown)
  --force-convert           Force PDF reconversion even if markdown exists
  --skip-topics             Skip topic extraction (use existing topics)
  --skip-resources          Skip learning resource extraction
  --review-topics           Interactive topic review (for domain experts)
  --convert-only            Stop after PDF conversion
  --batch-id <id>           Custom batch ID
  --markdown-file <path>    Use specified markdown file
  --dry-run                 Show what would be done without executing
```

### corpus-generate-questions.ts

Stage 1 (generation) + Stage 2 (validation). Hybrid model: Haiku for MCQ/T-F, Sonnet for typed answers.

```bash
npx tsx scripts/corpus-generate-questions.ts [options]

Options:
  --unit <unit-id>          Generate for specific unit
  --topic <name>            Generate for specific topic
  --difficulty <level>      beginner | intermediate | advanced
  --type <type>             multiple-choice | fill-in-blank | true-false | writing
  --writing-type <wtype>    Writing subtype (requires --type writing)
  --count <n>               Questions per topic/difficulty (default: 10)
  --write-db                Sync to database
  --batch-id <id>           Custom batch ID
  --model <model-id>        Override model for all types
  --skip-validation         Skip answer validation pass
  --dry-run                 Show what would be generated
```

### corpus-suggest-topics.ts

Extract teachable topics from markdown learning materials.

```bash
npx tsx scripts/corpus-suggest-topics.ts <markdown-file> <unit-id>
npx tsx scripts/corpus-suggest-topics.ts --consolidate
```

### corpus-extract-resources.ts

Extract learning resources (YouTube URLs, etc.) from markdown files.

```bash
npx tsx scripts/corpus-extract-resources.ts [options]

Options:
  --unit <unit-id>    Extract for specific unit (default: all)
  --write-db          Insert to database
  --dry-run           Show what would be extracted (default)
  --force             Re-extract even if resources exist
```

### corpus-plan-generation.ts

Analyze current question distribution and plan targeted generation.

```bash
npx tsx scripts/corpus-plan-generation.ts [options]

Options:
  --execute           Execute the generation plan
  --analyze-only      Only show distribution analysis
  --target-writing <n> Target writing percentage (default: 27)
```

---

### audit-mistral.ts

Stage 3 default auditor. 6-criteria gate + remediation (difficulty relabeling, variation removal).

```bash
npx tsx scripts/audit-mistral.ts [options]

Options:
  --unit <unit-id>         Filter by unit
  --difficulty <level>     Filter by difficulty
  --type <type>            Filter by question type
  --batch-id <id>          Filter by batch_id
  --limit <n>              Random sample of N
  --pending-only           Audit only pending questions
  --output <path>          Export results to JSON
  --write-db               Write quality_status + audit_metadata to DB
```

### audit-sonnet.ts

4-criteria gate, no remediation. Use for comparison runs.

```bash
npx tsx scripts/audit-sonnet.ts [options]
# Same filter options as audit-mistral.ts
```

### audit-compare-auditors.ts

Cross-model comparison: reads Sonnet + Mistral JSON exports, generates markdown report.

```bash
npx tsx scripts/audit-compare-auditors.ts [options]

Options:
  --sonnet <path>    Sonnet audit JSON (default: data/audit-sonnet.json)
  --mistral <path>   Mistral audit JSON (default: data/audit-mistral.json)
  --output <path>    Report output (default: docs/cross-validation-report.md)
```

---

### experiment-create.ts

Create an experiment record in the database.

```bash
npx tsx scripts/experiment-create.ts [options]
```

### experiment-generate.ts

Run an A/B experiment: reconvert PDF, generate + audit cohorts, compare.

```bash
npx tsx scripts/experiment-generate.ts --unit <unit-id> [options]

Options:
  --unit <unit-id>           Unit to experiment on (required)
  --name <name>              Experiment name
  --research-question <q>    Research question
  --hypothesis <h>           Hypothesis
  --variable <v>             Independent variable
  --metric <m>               Primary metric
  --auditor <m>              Audit model: 'mistral' (default) or 'sonnet'
  --dry-run                  Show steps without executing
```

### experiment-compare.ts

Compare cohorts within an experiment, generate report.

```bash
npx tsx scripts/experiment-compare.ts --experiment-id <uuid> [options]

Options:
  --experiment-id <uuid>  Experiment ID (required)
  --output <path>         Export JSON data
  --report <path>         Generate markdown report
```

---

### db-export-questions.ts

Export questions table to JSON.

```bash
npx tsx scripts/db-export-questions.ts [options]

Options:
  --output <path>       Output file (default: data/corpus-export.json)
  --columns <mode>      minimal (default) or full
  --unit <unit-id>      Filter by unit
  --difficulty <level>  Filter by difficulty
  --type <type>         Filter by question type
```

### db-test-connection.ts

Verify Supabase connectivity and schema.

```bash
npx tsx scripts/db-test-connection.ts
```

---

## Shared Libraries

### lib/pipeline-steps.ts

Step functions for the pipeline orchestrators. Used by `corpus-generate.ts` and `experiment-generate.ts`.

- `stepConvertPdf()` — PDF → Markdown conversion
- `stepExtractTopics()` — Topic discovery
- `stepAutoUpdateFiles()` — Auto-update units table in DB for new units
- `stepGenerateQuestions()` — Spawn question generation
- `stepAuditQuestions()` — Spawn quality audit
- `stepExtractResources()` — Spawn resource extraction

### lib/pdf-conversion.ts

PDF text extraction and Claude-based markdown conversion.

### lib/unit-discovery.ts

File resolution: find PDFs and markdown for a given unit ID.

### lib/script-runner.ts

Shared process helpers: `runScript()`, `runScriptAsync()`, `promptUser()`.

### lib/db-queries.ts

Supabase client init, paginated fetch, distribution analysis.

### lib/git-utils.ts

Git state capture and safety checks for experiment mode.

### lib/config.ts

Model IDs, type classifications, cost estimates.

### lib/topic-utils.ts

Topic name normalization, similarity detection, deduplication.

### lib/writing-type-inference.ts

Pattern-based writing subtype inference from question text.

### prompts/

Prompt templates for PDF conversion, audit criteria, and topic extraction.

---

## Environment Requirements

All scripts require `.env.local` with:

```env
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
ANTHROPIC_API_KEY=...

# For write operations (bypasses RLS):
SUPABASE_SECRET_KEY=...

# For Mistral audit:
MISTRAL_API_KEY=...
```

---

## Common Workflows

```bash
# Test database connection
npx tsx scripts/db-test-connection.ts

# Full pipeline for one unit
npx tsx scripts/corpus-generate.ts unit-4 --write-db --audit

# Generate questions only (no PDF conversion)
npx tsx scripts/corpus-generate-questions.ts --unit unit-2 --write-db

# Audit pending questions with Mistral
npx tsx scripts/audit-mistral.ts --pending-only --write-db

# Export questions for inspection
npx tsx scripts/db-export-questions.ts --output /tmp/questions.json

# Analyze distribution and plan generation
npx tsx scripts/corpus-plan-generation.ts --analyze-only

# Dry run to preview
npx tsx scripts/corpus-generate.ts unit-4 --write-db --audit --dry-run
```
