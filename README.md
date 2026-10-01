# Adaptive AI Assessment
_Modular LLM Orchestration · Cross-Provider Evaluation_

An adaptive language-learning quiz platform, built as a reference implementation of modular LLM orchestration and cross-provider model evaluation. Students practice with adaptive, Leitner-scheduled quizzes; questions are generated, validated, and audited by a TypeScript content pipeline that routes across Anthropic and Mistral models through OpenRouter. A separate model-evaluation framework in the same pipeline tests each of the pipeline's LLM-driven tasks against models from six vendors before any of them is trusted to replace what runs in production. Built with Next.js, TypeScript, and Supabase (PostgreSQL with Row-Level Security).

The system is a reference implementation of:

- Cross-provider model evaluation: frozen item sets, paired significance tests, and a durable experiment/findings/model-registry layer
- Multi-stage LLM generation, validation, and audit pipelines
- Model routing with provider separation
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

### Three-Stage Evaluation Pipeline

```text
Student Answer → Stage 1: Exact Match → Stage 2: Fuzzy Match → Stage 3: Semantic → Result
                    (normalized)         (Levenshtein)           (Opus 5.5)
```

- **Stage 1, Exact Match**: Normalized string comparison (case, whitespace, accents)
- **Stage 2, Fuzzy Match**: Levenshtein distance thresholds scaled by difficulty level
- **Stage 3, Semantic Fallback**: LLM-based evaluation for low-confidence cases

---

## Model Evaluation Framework

Production question generation, audit, and answer grading are pinned to specific models (Anthropic and Mistral). Before any of them changes, `apps/pipeline/` carries a separate evaluation framework. It runs the same tasks (question audit, answer grading, topic-to-heading mapping, and slide transcription) against models from Anthropic, OpenAI, Google, Mistral, DeepSeek, and Qwen, all through one OpenRouter integration.

Each run pins the model to a specific provider with fallbacks disabled, so a comparison never silently switches which infrastructure actually served a call. Mistral variants route through the project's own Mistral API key rather than shared OpenRouter capacity, so the comparison gets the same access production gets. Every call's cost comes from OpenRouter's own reported usage, not an estimate, and the host that actually served each call is recorded and checked against the pin that was requested. A result also keeps the OpenRouter response facts that have no column of their own (the response id, finish reason, and similar), minus any message content, so a question noticed later about one specific call does not require having captured it in advance.

**Keeping comparisons honest.** Items are drawn once into a frozen, hashed set, so a later run scores the exact same inputs. Multiple model variants run interleaved in blocks rather than one after another, so no model gets an easier or harder slice of the material by chance of order. Repeating the same variant measures how much a model's own randomness moves its score, a noise floor a real difference has to clear. Each task has its own non-inferiority tolerance: a candidate counts as a possible replacement only if its score is no worse than the current model's by more than that tolerance, and paired statistical tests (McNemar's exact test for pass/fail tasks, a sign test for continuous scores) back that verdict instead of a bare percentage comparison. Where a task needs ground truth, a human reviewer labels a sample of items; where it doesn't have that yet, the report says so and marks its numbers reference-free instead of presenting them as accuracy. A run refuses to start at all if its projected cost exceeds a budget cap.

**A durable record, not one-off scripts.** Every comparison is tied to a named experiment, and once decided, an append-only finding records what was concluded, by whom, and when; a later reversal adds a new finding rather than editing the old one. A dated model registry records each model's attributes (open or closed weights, total and active parameter count, architecture, release date, price, context window) as of when they were checked, since a vendor can silently repoint the same model identifier to different weights or pricing later. A handful of analysis views let a query compare models head to head or trace one model's family across versions over time. With as few repeats as these evaluations run, attributing a score difference to a specific model attribute, such as parameter count or architecture, is a hypothesis worth checking further, not a finding.

**Results so far** (measured September 2026):

| Task | Result |
|---|---|
| Heading-to-topic mapping | The current model, Sonnet 5, scored a mean F1 of about 0.81 to 0.82 across three repeats. Every alternative tried scored lower and fell outside the task's tolerance, so it stays the mapper. |
| Slide transcription | The current model, Sonnet 5, scored 0.95 against reviewed transcripts. Every alternative tried scored lower, from 0.78 to 0.91, so it stays the transcriber. |
| Audit call shape | Auditing one question per call, instead of batching five together, was adopted: it was as stable under model randomness as identical repeats of the batched design (a 2.8% vs 3.3% flip rate), and a hand check of the cases where the two designs disagreed found the batched design wrong more than five times as often as the single-question design. |

Auditor and answer-grading model comparisons are still reference-free, since there is no human-reviewed answer key yet to score against, so those results aren't reported here as accuracy.

See [`apps/pipeline/README.md`](apps/pipeline/README.md) for the full command reference and [`docs/pipeline-architecture.md`](docs/pipeline-architecture.md#evaluation-framework) for the framework's tables and mechanics.

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
- Reduce blind spots correlated with a single provider's model family
- Detect generation artifacts not caught by structural validation

Separating audit from the generation vendor strengthens reliability controls and reduces systemic evaluation risk.

---

## Reliability and Evaluation Strategy

Typed answers are evaluated through the three-stage evaluation pipeline described above, balancing precision, recall, and cost.

Additional safeguards:
- Lifecycle gating before production exposure
- Audit remediation loop
- Durable, sliding-window rate limiting (Upstash Redis, in-memory fallback outside production)
- Row-Level Security (RLS) policies
- HMAC-signed admin and student session cookies, CSRF protection on state-changing routes
- Cloudflare Turnstile challenge on the study-code circuit breaker
- Strict relational cascade-delete chains

The system prioritizes structured validation and guardrails over unchecked model generation.

---

## Core Features

**Student-facing**
- Four question types: multiple choice, true/false, fill-in-the-blank, writing
- Practice and assessment quiz modes
- Adaptive Leitner spaced-repetition scheduling, per-topic mastery tracking, and quiz history
- Tiered typed-answer grading: exact match, fuzzy match, then LLM-based semantic fallback
- Anonymous study codes for identity (no accounts, no PII)

**Admin**
- Dashboard (`/admin`, gated by `NEXT_PUBLIC_ENABLE_ADMIN_PANEL`) backed by `/api/admin/*` routes: study-code search, bulk delete, and CSV export
- Feature flags for runtime configuration

**Content pipeline**
- TypeScript commands (`apps/pipeline/`) that convert course PDFs to markdown, extract topics, and generate questions across Haiku and Sonnet
- Independent Mistral-based audit stage with a 6-criteria quality gate and remediation (difficulty relabeling, variation cleanup)

---

## Environment Configuration

The system is configurable via environment variables to support model routing, feature flagging, and deployment flexibility.

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | Admin only | Password for admin dashboard login |
| `ADMIN_SESSION_SECRET` | Admin only | Hex string for HMAC cookie signing |
| `COURSE_NAME` / `COURSE_TITLE` | Yes (deployed) | Course branding read by `packages/shared/src/course.ts`: the app title and header, and the pipeline's prompts. Server-side only; other clients read it from `GET /api/course`. Local development, tests and local builds fall back to "French II" / "French II Practice & Assessment"; a Vercel build or deployment, or a production server, fails without them |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Yes (deployed), one pair | Upstash Redis for durable rate limiting, as set by the Vercel Marketplace integration. Without a pair, the limiter runs in memory in development and tests, and denies requests in production builds (`NODE_ENV=production`, which includes Vercel previews) |
| `NEXT_PUBLIC_ENABLE_ADMIN_PANEL` | No | Enable admin dashboard (`true`/`false`) |
| `NEXT_PUBLIC_ENABLE_LEITNER` | No | Toggle adaptive question selection |
| `NEXT_PUBLIC_SHOW_STUDY_CODE` | No | Toggle study code display |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | No | Cloudflare Turnstile. When both are set, the study-code circuit breaker challenges suspected scanners instead of adding a fixed delay. Use Cloudflare's test keys outside production (see `.env.local.example`) |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for all model calls (generation, validation, audit, evaluation) |
| `STUDENT_SESSION_SECRET` | Yes | Hex string for signing the student session cookie; students cannot sign in without it |
| `SUPABASE_ACCESS_TOKEN` | No | Personal access token for the Supabase MCP server used by local Claude Code tooling; the app and scripts don't read it |
| `SUPABASE_SECRET_KEY` | Yes (scripts) | Supabase service role key for CLI DB writes |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Alternative | The same Upstash connection under the names some setups provide; either pair works |

Pipeline-only variables, including `EXPECTED_SUPABASE_REF` for the write-target guard, are documented in `apps/pipeline/README.md` and `docs/cli-guide-content-ingestion-and-question-pipeline.md` rather than duplicated here.

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
- `study_code_source_words`: Adjective/animal word pools used to generate study codes
- `llm_batch_jobs`: Bookkeeping for OpenRouter batch audit jobs (`--llm-batch` / `--llm-batch-resume`)

### Cascade Deletes

All FK relationships use `ON DELETE CASCADE` for automatic cleanup.

- **Batch deletion**: `batches` → `questions` → `question_results`, `leitner_state`; `batches` → `learning_resources`
- **Student deletion**: `study_codes` → `quiz_history` → `question_results`; `study_codes` → `question_results` (direct FK), `leitner_state`

These chains are independent. Deleting a batch does not affect student data, and vice versa.

---

## Project Structure

```text
adaptive-ai-assessment/
├── docs/                  # Architecture and analysis documentation
│   └── pipeline-architecture.md
├── apps/
│   ├── web/                # Next.js App Router application
│   │   ├── src/
│   │   │   ├── app/         # admin/, api/, progress/, resources/, quiz/[unitId]/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── lib/
│   │   └── tests/
│   └── pipeline/            # Question generation and audit tooling
│       ├── bin/pipeline.ts          # `pipeline` dispatcher (npm bin entry)
│       ├── src/
│       │   ├── commands/            # pipeline-run, questions-generate, content-suggest-topics,
│       │   │                        # questions-plan, content-extract-resources, questions-audit,
│       │   │                        # db-seed-study-code-words, db-export-questions,
│       │   │                        # db-check-connection
│       │   └── lib/                 # shared option parsing (lib/options/), dispatcher internals
│       │                            # (lib/dispatch/), Supabase/logging/PDF-conversion helpers
│       ├── prompts/
│       ├── content/                 # pdf/, markdown/, exports/, gitignored working files
│       └── tests/
├── packages/
│   └── shared/              # Modules imported by both apps/web and apps/pipeline
│       └── src/              # enums, llm, models, course, types
├── supabase/
│   └── schema.sql
└── package.json
```

See `docs/pipeline-architecture.md` for a deeper architectural walkthrough. Pipeline command usage details are in `apps/pipeline/README.md`, and a task-oriented walkthrough (ingesting a new unit, re-running generation, auditing) is in [`docs/cli-guide-content-ingestion-and-question-pipeline.md`](docs/cli-guide-content-ingestion-and-question-pipeline.md).

---

## Getting Started

### Prerequisites

- Node.js 24.x (see `.nvmrc`)
- OpenRouter API key
- Supabase project

### Installation

```bash
npm install
cp .env.local.example .env.local
# Edit .env.local with your API keys and Supabase credentials
# Apply supabase/schema.sql via the Supabase Dashboard SQL Editor
npm run dev
```

`npm install` at the repo root installs and links all three workspaces (`apps/web`, `apps/pipeline`, `packages/shared`). `.env.local` lives at the repo root. `apps/web/next.config.ts` loads it explicitly via `@next/env`'s `loadEnvConfig()`, and every pipeline command loads it via `apps/pipeline/src/lib/env.ts`, so there's one file to edit regardless of which part of the app you're running.

Open http://localhost:3000

`npm install` also links the `pipeline` command (`npx --no -- pipeline --help` works immediately from the
repo root). Always run the npx form from inside this repo, as `npx --no -- pipeline`: outside the repo, a plain
`npx pipeline` falls back to downloading and running an unrelated public npm package named
`pipeline`, and `--no` makes npx stop instead, and `--` keeps npx from reading the command's options as its own. To use bare `pipeline` from any folder, register it
once with `npm link` in `apps/pipeline`.

For zsh tab completion, pick one:

```zsh
# (a) Always current, ~200ms per new shell; add after the compinit line in ~/.zshrc:
source <(pipeline completion zsh)

# (b) Faster shell start, manual refresh; put before the compinit line in ~/.zshrc:
fpath=(~/.zfunc $fpath)
# then, once (and again after adding a command, adding a PDF, or pulling changes):
mkdir -p ~/.zfunc && pipeline completion zsh > ~/.zfunc/_pipeline
```

then `exec zsh` to reload. See `apps/pipeline/README.md`'s "The `pipeline` dispatcher" section for
bash completion (option (a) only), running `pipeline` without setup via `npx`, and guided mode.

---

## Testing

```bash
npm test              # Vitest, runs against a mocked/stubbed environment
npm run lint           # eslint .
```

By default, tests never touch a real database: a global setup step strips credential environment variables before each test file loads and again before each test body runs. A handful of tests need a real connection (RLS policy checks, live schema checks); those are gated behind `RUN_DB_TESTS=1` and read `process.env` directly inside their own `it()` blocks:

```bash
# Point at a test Supabase project, then opt in to the DB-backed tests
set -a; source .env.test.local; set +a
RUN_DB_TESTS=1 npm test
```

With `RUN_DB_TESTS=1`, the credential guard checks `NEXT_PUBLIC_SUPABASE_URL` against the test project's host before leaving credentials in place, and throws if it doesn't match, so a misconfigured run fails loudly instead of running live-DB tests against an unexpected project. Never point this at a production project.

---

## Deployment

Deploys to Vercel on push to `main`. Set the environment variables from `.env.local.example` in the Vercel project settings; the Upstash Redis integration (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) is available through the Vercel Marketplace.

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
