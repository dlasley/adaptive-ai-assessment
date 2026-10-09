# Adaptive AI Assessment

An adaptive quiz platform with a content pipeline and a model-evaluation framework. Students practice with Leitner-scheduled quizzes across four question types. A TypeScript pipeline converts course PDFs into questions, validates them, and audits them with a model from a different vendor before they are served. A separate framework in the same pipeline tests alternative models against the ones in production. Built with Next.js, TypeScript, and Supabase (PostgreSQL with Row-Level Security). Every model call goes through OpenRouter.

This repository contains no course content. Questions are generated from course PDFs you supply, which are gitignored, so a fresh install starts with an empty question bank.

## Documentation

- [`docs/pipeline-architecture.md`](docs/pipeline-architecture.md): the question pipeline's stages, gate criteria, model assignments, and the evaluation framework's tables.
- [`apps/pipeline/README.md`](apps/pipeline/README.md): what each `pipeline` command does.
- [`docs/cli-guide-content-ingestion-and-question-pipeline.md`](docs/cli-guide-content-ingestion-and-question-pipeline.md): task walkthroughs, from adding a unit to evaluating a model.

---

## Architecture

### Question pipeline

```text
Source content → Stage 1: Generation → Stage 2: Validation → Stage 3: Audit → Production
                  (Claude, two sizes)      (Claude)            (Mistral)
```

- **Generation**: the smaller Claude model writes multiple-choice and true/false questions at beginner and intermediate difficulty. The larger one writes typed-answer questions and everything at advanced difficulty.
- **Validation**: the larger Claude model checks answer correctness and grammar, re-labels difficulty, and proposes acceptable variations, before anything is inserted.
- **Audit**: a Mistral model, independent of the generating vendor, reviews each question against the course material it came from under a 6-criteria gate.

Questions move through a gated lifecycle:

- `pending`: generated but not served
- `active`: audited and approved for production
- `flagged`: excluded due to a quality failure

Using a different vendor for the audit reduces the chance that generator and reviewer share the same blind spots. PDF conversion also calls a Google model by default, as a classifier that skips slides with no teaching content. Exact model IDs live in `packages/shared/src/models.ts`.

### Typed-answer evaluation

```text
Student answer → Empty check → Exact match → Fuzzy match → Semantic (LLM) → Result
                                (normalized)  (one swap)
```

- **Empty check**: rejects an empty or too-short answer.
- **Exact match**: normalized string comparison (case, whitespace, accents).
- **Fuzzy match**: accepts an answer that equals an acceptable variation, or that differs from the correct answer or a variation by one pair of adjacent characters exchanged. It never marks an answer wrong.
- **Semantic fallback**: an LLM evaluates the cases the first three tiers cannot settle.

Each stored result records which tier settled it, in `question_results.graded_by`.

### Web app

The Next.js app (`apps/web/`) has no student accounts. A student enters or generates a study code, and the server answers with a signed session cookie (`student_session`, HMAC-signed, `httpOnly`). A native client that asks with `platform: "native"` receives the same signed value in the response body instead and sends it back as an `Authorization: Bearer` header; when that header is present it is the only credential the server considers. The native client stores that token itself, so the cookie's `httpOnly` protection does not apply to it; signing out on a native client means deleting the stored token, and for either transport an admin force-logout revokes the session by bumping its epoch. Admins log in with a shared password and receive a separately signed cookie (`admin_session`). `src/proxy.ts` redirects unauthenticated `/admin` page requests, and every `/api/admin/*` route verifies the cookie signature itself.

The browser reads only what the anonymous Supabase key can see under RLS: learning resources, whose rows are public links. The question bank and units are read by server routes with the service-role key, and CI fails if code queries them with the anonymous client. Everything about a student (study codes, quiz history, results, Leitner state) is reached only through `/api/*` routes that check the session and then use the service-role key; the anonymous role has no policies on those tables, and CI fails if code outside `apps/web/src/app/api/` queries them with the anonymous client. State-changing routes check the request's `Origin` or `Referer` against an allow-list and require a JSON `Content-Type` (CSRF). Rate limiting is sliding-window and backed by Upstash Redis, with an in-memory store outside production. Study-code verification adds a per-IP miss lock, a per-code lockout and a global circuit breaker, which challenges with Cloudflare Turnstile and requires it in production; admin login has its own global circuit breaker, which denies logins until its window ends. Student routes are limited per session, with looser per-IP backstops sized for a classroom behind one address; typed-answer grading by the model also has a global daily cap. A study code is two different adjectives and an animal (for example "brave purple penguin"); the word pools are a sample of two public lists, which raises the cost of guessing a code but does not hide the scheme. The QR code encodes the study code in a URL (`?code=`), so it can appear in browser history and in server or proxy logs; the home page removes it from the address bar after use.

---

## Model evaluation framework

Production question generation, audit, and answer grading are pinned to specific models. Before any of them changes, `apps/pipeline/` carries an evaluation framework. It runs four of the pipeline's LLM-driven tasks (question audit, answer grading, topic-to-heading mapping, and slide transcription) against alternative models through the same OpenRouter integration.

Each run can pin the model to a specific provider with fallbacks disabled, so a comparison does not silently switch which infrastructure served a call. To compare Mistral models on the same access production uses, add your own Mistral key to your OpenRouter account (OpenRouter's bring-your-own-key setting); the repository reads only `OPENROUTER_API_KEY`. Every call's cost comes from OpenRouter's reported usage, not an estimate, and the host that served each call is recorded and checked against the requested pin.

Comparison method:

- Items are drawn once into a frozen, hashed set, so a later run scores the same inputs.
- Variants run interleaved in blocks rather than one after another, so no model gets an easier slice by order.
- Repeating a variant measures how much a model's own randomness moves its score, a noise floor a real difference has to clear.
- Each task has a non-inferiority tolerance: a candidate is a possible replacement only if it is no worse than the current model by more than that tolerance, backed by paired tests (McNemar's exact test for pass/fail tasks, a sign test for continuous scores).
- Where a task needs ground truth, a human reviewer labels a sample. Where it does not exist yet, the report says so and marks its numbers reference-free instead of presenting them as accuracy.
- A run refuses to start if its projected cost exceeds a budget cap.

Records:

- Every comparison belongs to a named experiment. A decision is an append-only finding, and a later reversal adds a new finding instead of editing the old one.
- A dated model registry stores each model's attributes (weights, parameter count, architecture, release date, price, context window) as of when they were checked, since a vendor can repoint a model identifier to different weights or pricing.
- Views compare models head to head or trace a model family across versions.

See [`docs/pipeline-architecture.md`](docs/pipeline-architecture.md#evaluation-framework) for the tables and [`apps/pipeline/README.md`](apps/pipeline/README.md) for the commands.
See [`docs/evaluation-findings.md`](docs/evaluation-findings.md) for what the framework has found so far.

---

## Features

**Student-facing**
- Four question types: multiple choice, true/false, fill-in-the-blank, writing
- Practice and assessment quiz modes
- Adaptive Leitner spaced-repetition scheduling, per-topic mastery tracking, and quiz history
- Tiered typed-answer grading: exact match, a single-swap match, then an LLM semantic fallback
- Anonymous study codes for identity (no accounts; the app collects no names, though an owner can label a code with a name directly in the database)

**Admin**
- Dashboard (`/admin`): study-code search and bulk delete through `/api/admin/*`, and a CSV export generated in the browser. These are protected by the admin session alone; `NEXT_PUBLIC_ENABLE_ADMIN_PANEL` only shows the "Teacher Dashboard" navigation link
- Build-time feature flags (`NEXT_PUBLIC_*`, read in `apps/web/src/lib/feature-flags.ts`)

**Content pipeline**
- TypeScript commands (`apps/pipeline/`) that convert course PDFs to markdown, extract topics, and generate questions
- A Mistral audit stage with a 6-criteria quality gate and remediation (difficulty relabeling, variation cleanup)

---

## Environment Configuration

| Variable | Required | Description |
|---|---|---|
| `ADMIN_PASSWORD` | Admin only | Password for admin dashboard login. Must be at least 16 characters; a shorter one is refused (logged once) and nobody can log in |
| `ADMIN_SESSION_SECRET` | Admin only | Secret for HMAC cookie signing, at least 32 bytes (for example 64 hex characters); a shorter one fails at first use. An admin session lasts up to 24 hours and is revoked only by rotating this secret |
| `COURSE_NAME` / `COURSE_TITLE` | Yes (deployed) | Course branding read by `packages/shared/src/course.ts`: the app title and header, and the pipeline's prompts. Server-side only. Local development, tests and local builds fall back to "French II" / "French II Practice & Assessment"; a Vercel build or deployment, or a production server, fails without them |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Yes (deployed), one pair | Upstash Redis for durable rate limiting, as set by the Vercel Marketplace integration. Without a pair, the limiter runs in memory in development and tests, and denies requests in production builds (`NODE_ENV=production`, which includes Vercel previews) |
| `MODEL_GRADING_DAILY_CAP` | No | Most model calls for typed answers per UTC day, across all students; a retry after an unreadable reply counts as a second call. The count is kept per deployment environment (production, preview and development each get their own), so the OpenRouter credit limit is the only cap across all of them. Default 2000. Past it, answers get a score-50 "automatic grader unavailable until tomorrow" result instead of a model call |
| `NEXT_PUBLIC_ENABLE_ADMIN_PANEL` | No | Shows the "Teacher Dashboard" navigation link (`true`/`false`). Does not gate `/admin` or `/api/admin/*`, which the admin session protects |
| `NEXT_PUBLIC_ENABLE_LEITNER` | No | Toggle adaptive question selection |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Yes (production) | Cloudflare Turnstile. The study-code circuit breaker challenges suspected scanners with it, and a production-mode server (`NODE_ENV=production`, which includes Vercel previews) refuses study-code verification without both keys. Outside production, without them, the breaker answers 429 until its window ends. Use Cloudflare's test keys outside production (see `.env.local.example`); the live site rejects them |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for all model calls (generation, validation, audit, evaluation). Set a hard credit limit on the key in OpenRouter's dashboard; the app's own caps bound spend per student and per day but are not a billing control |
| `STUDENT_SESSION_SECRET` | Yes | Secret for signing the student session, both the web cookie and the native bearer token, at least 32 bytes (for example 64 hex characters); students cannot sign in without it |
| `SUPABASE_ACCESS_TOKEN` | No | Used by the Supabase MCP server for local tooling; the app and scripts do not read it |
| `SUPABASE_SECRET_KEY` | Yes | Supabase service role key. The web app's server routes and every pipeline command use it |
| `TRUSTED_PROXY_IP_HEADER` | Self-hosted behind a proxy | Name of the request header your own reverse proxy sets to the client address (for example `x-forwarded-for` or `cf-connecting-ip`). The last comma-separated value is used. Without it, a production-mode server takes the client address only from `x-real-ip`, which Vercel sets, and answers 500 on rate-limited routes when that header is missing. Leave it unset on Vercel; set it only when the proxy overwrites the header on every request |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Alternative | The same Upstash connection under the names some setups provide; either pair works |

Pipeline-only variables, including `EXPECTED_SUPABASE_REF` for the write-target guard, are documented in [`apps/pipeline/README.md`](apps/pipeline/README.md#environment).

---

## Database

The Supabase (PostgreSQL) schema is `supabase/schema.sql`. The application tables are:

- `units`: unit definitions, with each topic's name and the document headings it covers
- `study_codes`: anonymous student identifiers with per-user settings
- `quiz_history`: individual quiz attempts
- `question_results`: per-question results for analytics
- `questions`: all quiz questions (MCQ, T/F, fill-in-the-blank, writing)
- `batches`: question generation batch metadata (model, config, counts)
- `leitner_state`: spaced repetition box state per student per question
- `learning_resources`: videos, articles, and other resources by unit and topic
- `study_code_source_words`: adjective and animal word pools used to generate study codes
- `llm_batch_jobs`: bookkeeping for OpenRouter batch audit jobs

The `eval_*` tables and views belong to the evaluation framework and are service-role only. Deleting a batch cascades to its questions and their results, and deleting a study code cascades to that student's history and results, in two independent chains. See [`docs/pipeline-architecture.md`](docs/pipeline-architecture.md#data-hygiene-via-cascade-deletes) for the chains and the evaluation tables' different rules.

---

## Project Structure

```text
adaptive-ai-assessment/
├── apps/
│   ├── web/             # Next.js App Router application (src/app, src/lib, tests)
│   ├── mobile/          # Expo app for students (app, src, tests)
│   └── pipeline/        # Content pipeline and evaluation commands (bin, src, prompts, tests)
├── packages/
│   └── shared/          # Enums, model IDs, course settings, types, OpenRouter client
├── docs/                # Pipeline architecture and CLI guide
├── supabase/
│   └── schema.sql
├── tests/               # Repo-wide tests and the credential guard
└── .github/workflows/   # CI
```

---

## Getting Started

### Prerequisites

- Node.js 24.x (see `.nvmrc`)
- An OpenRouter API key
- A Supabase project
- Poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) for PDF conversion, for example `brew install poppler` or `apt install poppler-utils`

### Installation

```bash
npm install
cp .env.local.example .env.local
# Edit .env.local with your API keys and Supabase credentials
# Apply supabase/schema.sql via the Supabase Dashboard SQL Editor
npm run dev
```

`.env.local` lives at the repo root, and both the web app and every pipeline command load it from there. Open http://localhost:3000.

The app is empty until you add content:

1. **Seed the study-code word pools.** Study codes cannot be generated until `study_code_source_words` has rows:
   `npx --no -- pipeline db-seed-study-code-words --write-db`. Pipeline writes refuse to run until the Supabase target is confirmed, through `EXPECTED_SUPABASE_REF` or `--yes-production`; the [CLI guide](docs/cli-guide-content-ingestion-and-question-pipeline.md#2-safety-model) explains why.
2. **Add a unit.** Put your course PDF in `apps/pipeline/content/pdf/` and follow the [CLI guide's ingest workflow](docs/cli-guide-content-ingestion-and-question-pipeline.md#3-workflow-ingest-a-new-unit). Questions are served once the audit marks them `active`.
3. **Optional: register models for evaluation.** The model registry (`eval_models`) starts empty and no command fills it; see ["Registering a model"](docs/cli-guide-content-ingestion-and-question-pipeline.md#registering-a-model).

`npm install` links the `pipeline` command. Run it from the repo root as `npx --no -- pipeline --help` (the `--no --` matters: without it, npx can fetch an unrelated public package named `pipeline`). Shell completion and guided mode are described in [`apps/pipeline/README.md`](apps/pipeline/README.md).

### Mobile app

`apps/mobile/` is an Expo app that talks to the web app's `/api/*` routes, never to Supabase. To run it in Expo Go on the iOS simulator, start the web app with `npm run dev`, then in another terminal:

```bash
cd apps/mobile
npx expo start --ios
```

The app opens on study code entry. In the development profile that screen also links to a connection check, which shows the course title and unit count the API returns and sends the logout POST with and without the `Origin` header.

Two variables configure it, in `apps/mobile/.env.local` (copy `apps/mobile/.env.local.example`; Expo reads env files from `apps/mobile/` only, not from the repo root):

- `EXPO_PUBLIC_API_BASE_URL`: the web deployment to call. Unset, it defaults to `http://localhost:3000` in development (`expo start`, Expo Go); a `preview` or `production` build requires an `https` URL and otherwise opens on a screen naming the problem.
- `EXPO_PUBLIC_API_ORIGIN` (optional): the `Origin` header the app sends, which must be on the server's CSRF allow-list. It defaults to the base URL's origin. A physical device reaching `next dev` at your Mac's LAN address sets the base URL to that address and this to `http://localhost:3000`.

Every `EXPO_PUBLIC_` value is compiled into the app and readable by anyone who has it, so neither may hold a secret. Build profiles in `apps/mobile/eas.json` set `EXPO_PUBLIC_APP_PROFILE`, which is how the app tells development from `preview` and `production`.

Expo SDK 57 expects TypeScript 6. The repo stays on TypeScript 5.9 until a repo-wide upgrade, so `apps/mobile/package.json` excludes `typescript` from Expo's version check (`expo.install.exclude`).

---

## Testing

```bash
npm test          # Vitest, against a mocked environment
npm run lint
npm run typecheck
npm run knip      # unused files, exports, and dependencies
```

CI runs lint, knip, typecheck, and the tests on every push.

By default, tests never touch a real database: a global setup step strips credential environment variables before each test file loads and again before each test body. A few tests need a real connection (RLS policy checks, live schema checks); they are gated behind `RUN_DB_TESTS=1`:

```bash
# Point at a test Supabase project, then opt in to the DB-backed tests
set -a; source .env.test.local; set +a
RUN_DB_TESTS=1 npm test
```

There is no example for it: create a second Supabase project, apply `supabase/schema.sql` to it, and write `.env.test.local` by hand at the repo root. It holds the test project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SECRET_KEY`, plus `EXPECTED_SUPABASE_REF` set to that project's ref. With `RUN_DB_TESTS=1`, the credential guard checks the URL's host against that ref and throws if they differ, so a misconfigured run fails instead of running live-DB tests against an unexpected project. Never point this at a production project.

---

## Deployment

Deploys to Vercel on push to `main`. Set the environment variables from `.env.local.example` in the Vercel project settings; the Upstash Redis integration (`KV_REST_API_URL` / `KV_REST_API_TOKEN`) is available through the Vercel Marketplace.

---

## Security

To report a vulnerability, see [`SECURITY.md`](SECURITY.md).

---

## AI assistance

This project was built with AI assistance from Claude Code, using Anthropic models. The architecture, experiment design, and decisions about what ships were made and reviewed by the author.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
