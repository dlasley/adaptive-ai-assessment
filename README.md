# Adaptive AI Assessment
_Modular LLM Orchestration · Cross-Provider Evaluation · Experimentation Support_

An AI-native assessment platform demonstrating modular LLM orchestration, cross-provider model evaluation, and controlled experimentation support. Built with Next.js 15, TypeScript, Supabase (PostgreSQL + RLS), and multi-model AI pipelines (Anthropic + Mistral).

Originally developed as a purpose-built learning tool, the system evolved into a reference implementation of:

- Multi-stage LLM generation, validation, and audit pipelines
- Model routing with provider separation
- Isolated multi-cohort experimentation support
- Tiered semantic evaluation with structured fallbacks
- Adaptive learning algorithms (Leitner spaced repetition)
- Security-first design and relational data hygiene

---

## Architecture Overview

### Three-Stage Question Pipeline

```text
Source Content → Stage 1: Generation → Stage 2: Validation → Stage 3: Audit → Production
                   (LLM A₁, A₂)           (LLM A₂)               (LLM B)
```

- **LLM A₁ (Haiku)**: Cost-efficient primary generation
- **LLM A₂ (Sonnet)**: Higher-fidelity generation and structured validation
- **LLM B (Mistral Large)**: Independent cross-provider audit layer

#### Quality Lifecycle

Questions move through a gated lifecycle:

- `pending`: Generated but not served
- `active`: Audited and approved for production
- `flagged`: Excluded due to quality failure

Stage 2 enforces structural correctness and answer integrity. Stage 3 performs an independent semantic and quality review prior to production exposure.

This layered architecture reduces correlated model failure risk while preserving structured downstream validation controls.

---

## Model Selection Rationale

The system separates generation, validation, and audit across model tiers and providers to balance cost efficiency, output quality, and systemic risk.

### LLM A₁: Haiku (Cost-Efficient Generation)

Used for high-volume draft generation where speed and cost efficiency are prioritized.

### LLM A₂: Sonnet (Structured Validation and Higher-Fidelity Generation)

Used for:
- Higher-fidelity generation when needed
- Structured validation of grammar, correctness, and schema compliance

This stage ensures outputs meet structural and correctness constraints before independent audit.

### LLM B: Mistral Large (Independent Audit Layer)

Used as a final quality gate to:
- Provide cross-provider semantic evaluation
- Reduce correlated blind spots within a single model ecosystem
- Detect generation artifacts not caught by structural validation

Separating audit from the generation vendor strengthens reliability controls and reduces systemic evaluation risk.

---

## Experimentation Support

The platform includes isolated experimentation support:

- Dedicated `experiments` table
- `experiment_batches` and `experiment_questions` isolated from production
- Snapshot isolation to prevent contamination of live data
- CLI-driven unattended experiment runner
- Structured comparison tooling for reviewing and analyzing multi-cohort outputs

This enables safe evaluation of:
- Provider swaps
- Prompt modifications
- Audit criteria changes
- Validation threshold tuning
- Pipeline configuration adjustments

Experiments do not impact production question sets.

---

## Reliability and Evaluation Strategy

Typed answers use a tiered evaluation system designed to balance precision, recall, and cost:

1. Exact match (normalized comparison)
2. Fuzzy match (Levenshtein distance thresholds by difficulty)
3. Semantic fallback (LLM-based evaluation for low-confidence cases)

Additional safeguards:
- Lifecycle gating before production exposure
- Audit remediation loop
- Sliding-window rate limiting
- Row-Level Security (RLS) policies
- HMAC-signed admin sessions
- Strict relational cascade-delete chains

The system prioritizes structured validation and guardrails over unchecked model generation.

---

## Core Features

- Four question types: multiple choice, true/false, fill-in-the-blank, writing
- Practice and assessment modes
- Adaptive Leitner spaced-repetition algorithm
- Per-topic mastery tracking and quiz history
- Experiment framework for pipeline comparisons
- Anonymous study codes (no PII accounts required)
- Admin dashboard with CSV export and bulk operations
- Feature flags for runtime configuration

---

## Environment Configuration

The system is configurable via environment variables to support model routing, feature flagging, and deployment flexibility.

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for generation and validation |
| `MISTRAL_API_KEY` | Yes (audit) | Mistral API key for Stage 3 audit |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `SUPABASE_SECRET_KEY` | Yes (scripts) | Supabase service role key for CLI DB writes |
| `ADMIN_PASSWORD` | Admin only | Password for admin dashboard login |
| `ADMIN_SESSION_SECRET` | Admin only | Hex string for HMAC cookie signing |
| `NEXT_PUBLIC_ENABLE_ADMIN_PANEL` | No | Enable admin dashboard (`true`/`false`) |
| `NEXT_PUBLIC_SHOW_STUDY_CODE` | No | Toggle study code display |
| `NEXT_PUBLIC_ENABLE_LEITNER` | No | Toggle adaptive question selection |

---

## Database

Supabase (PostgreSQL) schema includes:

- `units`: Unit definitions with topics and heading aliases
- `study_codes`: Anonymous student identifiers with per-user settings
- `quiz_history`: Individual quiz attempts
- `question_results`: Per-question results for analytics
- `questions`: All quiz questions (MCQ, T/F, fill-in-the-blank, writing)
- `batches`: Question generation batch metadata (model, config, counts)
- `leitner_state`: Spaced repetition box state per student per question
- `learning_resources`: Videos, articles, and other resources by unit and topic
- `experiments`: Experiment records with design metadata and results
- `experiment_questions`: Experiment question snapshots (isolated from production)
- `experiment_batches`: Experiment batch metadata (isolated from production)

### Cascade Deletes

All FK relationships use `ON DELETE CASCADE` for automatic cleanup.

- **Batch deletion**: `batches` → `questions` → `question_results`, `leitner_state`; `batches` → `learning_resources`
- **Student deletion**: `study_codes` → `quiz_history` → `question_results`; `study_codes` → `question_results` (direct FK), `leitner_state`
- **Experiment deletion**: `experiments` → `experiment_batches` → `experiment_questions`

These chains are independent. Deleting a batch does not affect student data, and vice versa.

---

## Project Structure

```text
adaptive-ai-assessment/
├── docs/                  # Architecture and analysis documentation
│   └── pipeline-architecture.md
├── scripts/               # Question generation, audit, and experiment tooling
│   ├── corpus-generate.ts           # Pipeline orchestrator
│   ├── corpus-generate-questions.ts # Question generation
│   ├── corpus-suggest-topics.ts     # Topic extraction from markdown
│   ├── corpus-plan-generation.ts    # Coverage analysis and planning
│   ├── corpus-extract-resources.ts  # Learning resource extraction
│   ├── audit-mistral.ts             # Cross-provider audit (Mistral)
│   ├── audit-sonnet.ts              # Same-provider audit (Sonnet)
│   ├── audit-compare-auditors.ts    # Auditor comparison tooling
│   ├── experiment-create.ts         # Create experiment definitions
│   ├── experiment-generate.ts       # Run experiment pipelines
│   ├── experiment-compare.ts        # Compare experiment results
│   ├── db-seed-units.ts             # Seed units table
│   ├── db-export-questions.ts       # Export questions to JSON
│   ├── db-test-connection.ts        # Verify DB connectivity
│   ├── prompts/
│   └── lib/
├── supabase/
│   └── schema.sql
├── src/
│   ├── app/               # Next.js App Router
│   │   ├── admin/
│   │   ├── api/
│   │   ├── progress/
│   │   ├── resources/
│   │   └── quiz/[unitId]/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   └── types/
└── package.json
```

See `docs/pipeline-architecture.md` for a deeper architectural walkthrough. Script usage details are in `scripts/README.md`.

---

## Getting Started

### Prerequisites

- Node.js 18+
- Anthropic API key
- Mistral API key (for audit)
- Supabase project

### Installation

```bash
npm install
cp .env.example .env.local
# Edit .env.local with your API keys and Supabase credentials
# Apply supabase/schema.sql via the Supabase Dashboard SQL Editor
npm run dev
```

Open http://localhost:3000

---

## Development Philosophy

Built using AI-assisted development tooling while maintaining human ownership of architectural decisions, experiment design, separation of concerns, and reliability controls. AI accelerated implementation; system design and evaluation strategy were deliberate and human-directed.

The focus throughout was:
- Explicit architecture over implicit coupling
- Experiment isolation over uncontrolled iteration
- Provider separation over tight dependency coupling
- Structured validation and guardrails over unchecked generation

---

## License

MIT License. See [LICENSE](LICENSE) for details.
