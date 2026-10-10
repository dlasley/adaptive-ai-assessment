-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Study Codes Table
-- Stores anonymous student identifiers and basic info
CREATE TABLE study_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  display_name TEXT, -- Optional label set by the owner in the database; the app never collects or writes it
  admin_label TEXT, -- Optional label/identifier assigned by admin, not visible to students
  is_superuser BOOLEAN DEFAULT false NOT NULL, -- Enables detailed evaluation metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  total_quizzes INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  correct_answers INTEGER DEFAULT 0,
  wrong_answer_countdown INTEGER DEFAULT NULL, -- Per-user override for wrong answer countdown (NULL = global default)
  session_epoch INTEGER NOT NULL DEFAULT 1 -- Bumped to revoke all of this student's active session cookies before expiry
  -- No code_format constraint: the app generates codes ("adjective adjective animal") and looks them up as stored strings
);

-- Index for ordering by creation date (code column already indexed via UNIQUE constraint)
CREATE INDEX idx_study_codes_created_at ON study_codes(created_at DESC);

-- Partial index for efficient superuser lookups
CREATE INDEX idx_study_codes_superuser ON study_codes(is_superuser) WHERE is_superuser = true;

-- Quiz History Table
-- Stores individual quiz attempts
CREATE TABLE quiz_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  study_code_id UUID REFERENCES study_codes(id) ON DELETE CASCADE,
  quiz_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  unit_id TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  total_questions INTEGER NOT NULL,
  correct_answers INTEGER NOT NULL,
  score_percentage NUMERIC(5,2) NOT NULL,
  time_spent_seconds INTEGER,

  CONSTRAINT valid_score CHECK (score_percentage >= 0 AND score_percentage <= 100)
);

CREATE INDEX idx_quiz_history_study_code ON quiz_history(study_code_id, quiz_date DESC);
CREATE INDEX idx_quiz_history_date ON quiz_history(quiz_date DESC);

-- Batches Metadata Table
-- Tracks provenance for each question generation batch run
CREATE TABLE batches (
  id TEXT PRIMARY KEY,                         -- e.g., 'batch_2026-02-11_1770838456766'
  created_at TIMESTAMPTZ DEFAULT NOW(),        -- When the batch started
  model TEXT,                                  -- Primary/default model for the batch
  unit_id TEXT,                                -- Target unit (or 'all')
  difficulty TEXT,                             -- Difficulty filter (or 'all')
  type_filter TEXT,                            -- Type filter if any (or 'all')
  question_count INTEGER DEFAULT 0,            -- Total questions generated
  inserted_count INTEGER DEFAULT 0,            -- Questions inserted (after dedup)
  duplicate_count INTEGER DEFAULT 0,           -- Duplicates skipped
  error_count INTEGER DEFAULT 0,              -- Errors encountered
  config JSONB DEFAULT '{}'::jsonb,            -- Full CLI args snapshot
  quality_metrics JSONB,                       -- Stage 1+2 filtering stats (meta_filtered, validation_pass_rate, etc.)
  description TEXT,                            -- Human or AI description of batch context
  prompt_hash TEXT                             -- sha256 (16 hex) of the rendered generation +
                                                -- validation prompt templates actually used (not
                                                -- the model names) — changes whenever prompt
                                                -- wording changes, even if the model doesn't.
                                                -- Rows with config.git.commit earlier than
                                                -- e543eea carry sha256(structuredModel +
                                                -- typedModel) instead; the two are not comparable.
);

-- Questions Table (Unified)
-- All question types: multiple-choice, true-false, fill-in-blank, writing
CREATE TABLE questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Core fields (all question types)
  question TEXT NOT NULL,                    -- The question text
  correct_answer TEXT NOT NULL,              -- The correct answer
  explanation TEXT,                          -- Why this is correct
  unit_id TEXT NOT NULL,                     -- e.g., 'unit-2'
  topic TEXT NOT NULL,                       -- e.g., 'Days of the Week'
  difficulty TEXT NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),

  -- Question format type
  type TEXT NOT NULL CHECK (type IN ('multiple-choice', 'true-false', 'fill-in-blank', 'writing')),

  -- Type-specific fields (nullable based on type)
  options TEXT[],                            -- MCQ/TF: choices presented to user
  acceptable_variations TEXT[] DEFAULT '{}', -- Writing/fill-in-blank: alternate correct answers
  writing_type TEXT CHECK (writing_type IS NULL OR writing_type IN ('translation', 'conjugation', 'open_ended', 'question_formation', 'sentence_building')),
  hints TEXT[] DEFAULT '{}',                 -- Progressive hints (optional)
  has_complete_sentence_requirement BOOLEAN DEFAULT FALSE,

  -- Metadata for tracking/deduplication
  content_hash TEXT,                         -- MD5 hash for deduplication
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE, -- Generation batch identifier
  source_file TEXT,                          -- Learning material source
  generated_by TEXT,                         -- Model ID that generated this question (per-question for multi-model support)
  quality_status TEXT DEFAULT 'pending' CHECK (quality_status IN ('active', 'flagged', 'pending')),
  audit_metadata JSONB,                      -- Stage 3 audit & remediation diagnostic snapshot
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_questions_unit ON questions(unit_id);
CREATE INDEX idx_questions_topic ON questions(topic);
CREATE INDEX idx_questions_difficulty ON questions(difficulty);
CREATE INDEX idx_questions_type ON questions(type);
CREATE INDEX idx_questions_content_hash ON questions(content_hash);
CREATE INDEX idx_questions_batch_id ON questions(batch_id);
CREATE INDEX idx_questions_generated_by ON questions(generated_by);
CREATE INDEX idx_questions_unit_topic_diff ON questions(unit_id, topic, difficulty);
CREATE INDEX idx_questions_unit_type ON questions(unit_id, type);
CREATE INDEX idx_questions_quality_status ON questions(quality_status);

-- Question Results Table
-- Stores individual question attempts for detailed analytics
CREATE TABLE question_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quiz_history_id UUID REFERENCES quiz_history(id) ON DELETE CASCADE,
  study_code_id UUID REFERENCES study_codes(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  is_correct BOOLEAN NOT NULL,
  user_answer TEXT,
  correct_answer TEXT NOT NULL,
  score INTEGER DEFAULT NULL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  graded_by TEXT DEFAULT NULL CHECK (graded_by IN ('empty', 'exact', 'variation', 'swap', 'variation_swap', 'noise', 'semantic')),
  attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_question_results_study_code ON question_results(study_code_id);
CREATE INDEX idx_question_results_topic ON question_results(study_code_id, topic);

-- Leitner Spaced Repetition State
-- Tracks per-student per-question box assignments for adaptive question selection
CREATE TABLE leitner_state (
  study_code_id UUID NOT NULL REFERENCES study_codes(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  box INTEGER NOT NULL DEFAULT 1 CHECK (box >= 1 AND box <= 5),
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_reviewed TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  PRIMARY KEY (study_code_id, question_id)
);

CREATE INDEX idx_leitner_state_study_code ON leitner_state(study_code_id);
CREATE INDEX idx_leitner_state_box ON leitner_state(study_code_id, box);

-- Units Table
-- Course unit definitions with topic/heading mappings (source of truth for unit structure)
CREATE TABLE units (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  label TEXT,
  description TEXT NOT NULL,
  topics JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Filename stem (no extension) of this unit's source PDF/markdown in PDF/
  -- and learnings/, e.g. 'French II Unit 3'. Set by the pipeline when it
  -- discovers and upserts a new unit (apps/pipeline/lib/pipeline-steps.ts); null
  -- for units the pipeline hasn't (re)discovered since this column was added.
  source_file_stem TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Learning Resources Table
-- Stores learning resources (videos, articles, etc.) organized by unit and topic
CREATE TABLE learning_resources (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  unit_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('video', 'article', 'audio', 'interactive')),
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  provider TEXT,
  difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('beginner', 'intermediate', 'advanced')),
  duration_seconds INTEGER,
  thumbnail_url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  content_hash TEXT,
  source_file TEXT,
  batch_id TEXT REFERENCES batches(id) ON DELETE CASCADE,
  quality_status TEXT DEFAULT 'active' CHECK (quality_status IN ('active', 'flagged', 'pending')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_learning_resources_unit ON learning_resources(unit_id);
CREATE INDEX idx_learning_resources_unit_topic ON learning_resources(unit_id, topic);
CREATE INDEX idx_learning_resources_topic ON learning_resources(topic);
CREATE INDEX idx_learning_resources_content_hash ON learning_resources(content_hash);
CREATE INDEX idx_learning_resources_quality ON learning_resources(quality_status);

-- Study Code Source Words Table
-- Adjective/animal pools for server-side code generation (never exposed via anon key)
CREATE TABLE study_code_source_words (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('adjective', 'animal')),
  word TEXT NOT NULL,
  first_letter CHAR(1) NOT NULL GENERATED ALWAYS AS (LEFT(word, 1)) STORED,
  UNIQUE(category, word)
);

CREATE INDEX idx_study_code_source_words_category_letter
  ON study_code_source_words(category, first_letter);

ALTER TABLE study_code_source_words ENABLE ROW LEVEL SECURITY;
-- No anon policies → invisible to public API, only accessible via service role

-- Concept Mastery View
-- Aggregates performance by topic for each student
CREATE VIEW concept_mastery WITH (security_invoker = true) AS
SELECT
  study_code_id,
  topic,
  COUNT(*) as total_attempts,
  SUM(CASE WHEN is_correct THEN 1 ELSE 0 END) as correct_attempts,
  ROUND(
    (SUM(CASE WHEN is_correct THEN 1 ELSE 0 END)::NUMERIC / COUNT(*)::NUMERIC) * 100,
    2
  ) as mastery_percentage,
  MAX(attempted_at) as last_attempted
FROM question_results
GROUP BY study_code_id, topic;

-- Weak Topics View
-- Identifies topics where student is struggling (< 70% accuracy)
CREATE VIEW weak_topics WITH (security_invoker = true) AS
SELECT
  study_code_id,
  topic,
  total_attempts,
  correct_attempts,
  mastery_percentage
FROM concept_mastery
WHERE mastery_percentage < 70 AND total_attempts >= 1
ORDER BY mastery_percentage ASC;

-- Strong Topics View
-- Identifies topics where student has mastered (>= 85% accuracy)
CREATE VIEW strong_topics WITH (security_invoker = true) AS
SELECT
  study_code_id,
  topic,
  total_attempts,
  correct_attempts,
  mastery_percentage
FROM concept_mastery
WHERE mastery_percentage >= 85 AND total_attempts >= 5
ORDER BY mastery_percentage DESC;

-- Function to update last_active timestamp
CREATE OR REPLACE FUNCTION update_last_active()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE study_codes
  SET last_active_at = NOW()
  WHERE id = NEW.study_code_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

-- Trigger to auto-update last_active on quiz submission
CREATE TRIGGER update_study_code_last_active
AFTER INSERT ON quiz_history
FOR EACH ROW
EXECUTE FUNCTION update_last_active();

-- Generic trigger function to bump updated_at, shared by every table below
-- that carries the column
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

-- Trigger to auto-update updated_at on questions
CREATE TRIGGER questions_updated_at
  BEFORE UPDATE ON questions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Auto-update updated_at on units (reuses shared trigger function)
CREATE TRIGGER units_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Auto-update updated_at on learning_resources (reuses shared trigger function)
CREATE TRIGGER learning_resources_updated_at
  BEFORE UPDATE ON learning_resources
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Row Level Security (RLS) Policies
-- Enable RLS on all tables
ALTER TABLE study_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE leitner_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_resources ENABLE ROW LEVEL SECURITY;

-- study_codes, quiz_history, question_results, and leitner_state carry no
-- anon policies: all access goes through server routes using
-- supabaseAdmin (service_role bypasses RLS), which verify a signed
-- session cookie before touching a row. RLS stays ENABLED on all four
-- with zero permissive policies for anon, i.e. deny-by-default.

-- questions and units carry no anon policies either: the question bank holds answers and audit
-- metadata, and the unit rows hold course section headings. Server routes read them with
-- supabaseAdmin and return only the fields a student needs.

-- Learning resources policies (read-only for anon; scripts use secret key for writes)
CREATE POLICY "anon_select_learning_resources"
  ON learning_resources FOR SELECT
  TO anon
  USING (true);

-- Table and column comments
COMMENT ON TABLE study_codes IS 'Anonymous student identifiers';
COMMENT ON TABLE quiz_history IS 'Individual quiz attempts';
COMMENT ON TABLE question_results IS 'Detailed question-by-question results';
COMMENT ON TABLE questions IS 'All quiz questions (MCQ, T/F, fill-in-blank, writing)';
COMMENT ON VIEW concept_mastery IS 'Topic mastery by student';
COMMENT ON VIEW weak_topics IS 'Topics where student needs help';
COMMENT ON VIEW strong_topics IS 'Topics where student excels';
COMMENT ON COLUMN study_codes.admin_label IS 'Optional label/identifier that admin can assign to a student. Not visible to students.';
COMMENT ON COLUMN study_codes.is_superuser IS 'When true, user receives detailed evaluation metadata including confidence scores, similarity metrics, and which evaluation tier was used';
COMMENT ON COLUMN study_codes.wrong_answer_countdown IS 'Per-user override for wrong answer countdown seconds. NULL = use global default from FEATURES.WRONG_ANSWER_COUNTDOWN_SECONDS';
COMMENT ON COLUMN study_codes.session_epoch IS 'Bumped to invalidate all of a student''s active session cookies before their natural expiry (e.g. an admin forceLogout). A session cookie is rejected once its embedded sessionEpoch no longer matches this value.';
COMMENT ON COLUMN questions.has_complete_sentence_requirement IS 'Advanced questions requiring full sentence responses';
COMMENT ON COLUMN questions.content_hash IS 'MD5 hash of normalized question content for deduplication during regeneration';
COMMENT ON COLUMN questions.batch_id IS 'Identifies which generation batch created this question (e.g., 2026-02-04_unit3)';
COMMENT ON COLUMN questions.source_file IS 'Path to the markdown learning file used to generate this question';
COMMENT ON COLUMN questions.generated_by IS 'Model ID that generated this question (e.g., claude-haiku-4-5-20251001). Per-question for multi-model support.';
COMMENT ON COLUMN questions.quality_status IS 'Audit status: pending (awaiting audit, not served), active (serves to students), or flagged (excluded from quizzes)';
COMMENT ON COLUMN questions.audit_metadata IS 'Stage 3 audit & remediation diagnostic snapshot: criteria results, suggested_difficulty, missing/invalid variations. Written by audit scripts alongside quality_status. Mistral applies difficulty relabeling + invalid variation removal.';
COMMENT ON TABLE batches IS 'Metadata for each question generation batch run. Tracks pipeline state, model, config, and results.';
COMMENT ON COLUMN question_results.score IS 'Evaluation score 0-100. NULL for legacy data. MCQ/TF are always 0 or 100. Typed answers use fuzzy/API evaluation score.';
COMMENT ON COLUMN question_results.graded_by IS 'Which grading path settled a typed answer: empty, exact, variation, swap, variation_swap, noise or semantic. NULL for multiple-choice and true-false rows (graded by equality on the server), for rows written before the column existed, and for a typed answer the grading route never graded.';
COMMENT ON TABLE leitner_state IS 'Leitner spaced repetition box assignments per student per question';
COMMENT ON COLUMN leitner_state.box IS 'Leitner box 1-5. Box 1 = most frequent review, Box 5 = mastered';
COMMENT ON COLUMN leitner_state.consecutive_correct IS 'Number of consecutive correct answers. Resets to 0 on wrong answer.';
COMMENT ON COLUMN leitner_state.last_reviewed IS 'When this question was last attempted';
COMMENT ON TABLE learning_resources IS 'Learning resources (videos, articles, etc.) organized by unit and topic. Resource-type-agnostic for future extensibility.';
COMMENT ON TABLE study_code_source_words IS 'Adjective and animal word pools for server-side study code generation. A study code is two different adjectives and an animal; drawing from a seeded sample of the source word lists raises the cost of guessing a code but does not hide the scheme. No anon RLS: only service role can access.';
COMMENT ON COLUMN study_code_source_words.first_letter IS 'First letter of the word. Code generation matches the second adjective to an animal with the same first letter.';
COMMENT ON COLUMN study_codes.display_name IS 'Optional label an owner can set directly in the database. The app does not collect or write it.';
COMMENT ON COLUMN learning_resources.provider IS 'Content host identifier: youtube, vimeo, etc.';
COMMENT ON COLUMN learning_resources.metadata IS 'Extensible JSON: videoId, isShort, channelName, language, etc.';
COMMENT ON COLUMN learning_resources.content_hash IS 'MD5(url|unit_id|topic) for deduplication during extraction';
COMMENT ON VIEW weak_topics IS 'Topics where student needs help (< 70% accuracy, >= 1 attempt)';

-- ============================================================
-- LLM Batch Jobs
-- Bookkeeping for OpenRouter batch submissions. Child of batches:
-- one question-generation run can spawn 2+ OpenRouter batch jobs (generation, validation).
-- ============================================================

CREATE TABLE llm_batch_jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_batch_id TEXT NOT NULL UNIQUE,        -- OpenRouter's batch id ("batch_123")
  stage             TEXT NOT NULL CHECK (stage IN ('generation', 'validation', 'audit')),
  pipeline_batch_id TEXT NOT NULL,               -- FK by convention only, not constraint — points at
                                                  -- batches.id, mirroring questions' own pattern of
                                                  -- an unconstrained batch_id column
  unit_id           TEXT,
  model             TEXT NOT NULL,               -- sync slug; batch slug appends ':batch'
  provider_only     TEXT,                        -- batch-level provider pin, audit stage only
  status            TEXT NOT NULL DEFAULT 'validating',
  request_counts    JSONB,                       -- {total, completed, failed} — refreshed on each poll
  custom_id_context JSONB NOT NULL,               -- maps each custom_id to what's needed to apply its
                                                  -- result: question ids for audit, {topic, difficulty,
                                                  -- pass} for generation/validation
  error             JSONB,                        -- whole-batch failure payload (OpenRouter's top-level
                                                  -- `error`, when status='failed' pre-execution)
  is_fallback_applied BOOLEAN NOT NULL DEFAULT false, -- true once this job's requests were routed through
                                                  -- the sync helper after a whole-batch failure
  total_cost_usd    NUMERIC,                     -- Sum of every request's usage.cost; set on apply, null until then
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  applied_at        TIMESTAMPTZ,                  -- set only via the atomic conditional UPDATE guard
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_llm_batch_jobs_pipeline_batch ON llm_batch_jobs(pipeline_batch_id);
CREATE INDEX idx_llm_batch_jobs_status ON llm_batch_jobs(status);
CREATE INDEX idx_llm_batch_jobs_unapplied ON llm_batch_jobs(applied_at) WHERE applied_at IS NULL;

CREATE TRIGGER llm_batch_jobs_updated_at
  BEFORE UPDATE ON llm_batch_jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- RLS for llm_batch_jobs — no anon or authenticated policies (pipeline provenance
-- data, no known browser call site; service role bypasses RLS for scripts' reads/writes)
ALTER TABLE llm_batch_jobs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE llm_batch_jobs IS 'Bookkeeping for OpenRouter batch submissions (generation, validation, audit). One row per submitted OpenRouter batch job; pipeline_batch_id joins back to batches.';
COMMENT ON COLUMN llm_batch_jobs.pipeline_batch_id IS 'Points at batches.id. Unconstrained by design, mirroring questions.batch_id.';
COMMENT ON COLUMN llm_batch_jobs.custom_id_context IS 'Maps each request custom_id to what is needed to apply its result: question ids for audit, {topic, difficulty, pass} for generation/validation.';
COMMENT ON COLUMN llm_batch_jobs.error IS 'Whole-batch pre-execution failure payload (OpenRouter''s top-level error), set only when status reaches failed before any request in the batch executed.';
COMMENT ON COLUMN llm_batch_jobs.applied_at IS 'Set only via the atomic conditional UPDATE guard (WHERE applied_at IS NULL) that claims a job for result application, preventing two concurrent resume invocations from double-applying results.';
COMMENT ON COLUMN llm_batch_jobs.total_cost_usd IS 'Total OpenRouter cost (USD) across every request in this batch job, summed from each result''s usage.cost when the job is applied. Null until applied.';

-- ============================================================
-- Evaluation framework
-- Task-agnostic model evaluation: a frozen item sample (eval_sets/eval_items),
-- graded against reference labels a reviewer approves, and the variants run against it
-- (eval_runs/eval_results). Service-role only — no anon or authenticated
-- policies, same rationale as llm_batch_jobs: pipeline/reviewer tooling, no
-- browser call site.
-- ============================================================

CREATE TABLE eval_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task          TEXT NOT NULL CHECK (task IN ('audit', 'grading', 'generation', 'validation', 'transcription', 'mapping')),
  unit_id       TEXT,
  source        TEXT NOT NULL,                    -- e.g. a batch id, 'reference', 'slides' — where the items were drawn from
  item_count    INTEGER NOT NULL DEFAULT 0,
  selection     JSONB NOT NULL DEFAULT '{}'::jsonb, -- strata, seed, and filters the sample was drawn with
  inputs_hash   TEXT,                              -- hash of the frozen inputs the items depend on (unit markdown, units row)
  label         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eval_sets_task ON eval_sets(task);
CREATE INDEX idx_eval_sets_unit ON eval_sets(unit_id);

CREATE TRIGGER eval_sets_updated_at
  BEFORE UPDATE ON eval_sets
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE eval_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id        UUID NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  item_key      TEXT NOT NULL,                     -- stable within a set, e.g. a question id or slide ref
  payload       JSONB NOT NULL,                    -- frozen input snapshot the item was sampled with
  seeded_class  TEXT,                               -- design-time label the item was constructed to carry; never a reviewer verdict
  reference     JSONB,                              -- reviewer-assigned labels, null until reviewed
  reference_status TEXT NOT NULL DEFAULT 'pending' CHECK (reference_status IN ('pending', 'approved', 'rejected')),
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (set_id, item_key)
);

CREATE INDEX idx_eval_items_set ON eval_items(set_id);
CREATE INDEX idx_eval_items_reference_status ON eval_items(reference_status);

CREATE TRIGGER eval_items_updated_at
  BEFORE UPDATE ON eval_items
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE eval_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id            UUID NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  task              TEXT NOT NULL CHECK (task IN ('audit', 'grading', 'generation', 'validation', 'transcription', 'mapping')),
  variant_label     TEXT,
  model             TEXT NOT NULL,
  provider_pin      TEXT,
  prompt_hash       TEXT,
  settings          JSONB NOT NULL DEFAULT '{}'::jsonb, -- temperature, max_tokens, reasoning, provider, etc.
  judge_model       TEXT,                           -- set only for tasks scored by a fixed LLM judge rather than reference
  judge_prompt_hash TEXT,
  repeat_index      INTEGER NOT NULL DEFAULT 1,      -- distinguishes repeated runs of the same variant (noise-floor measurement)
  projected_cost_usd NUMERIC,                        -- estimated before the run started; the run refuses to start above --max-cost
  status            TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'aborted')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  summary           JSONB,                          -- aggregate metrics computed once every item has a result
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eval_runs_set ON eval_runs(set_id);
CREATE INDEX idx_eval_runs_task ON eval_runs(task);
CREATE INDEX idx_eval_runs_status ON eval_runs(status);

CREATE TRIGGER eval_runs_updated_at
  BEFORE UPDATE ON eval_runs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE TABLE eval_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              UUID NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  item_id             UUID NOT NULL REFERENCES eval_items(id) ON DELETE CASCADE,
  output              JSONB,                        -- the variant's raw output for this item
  judge_verdict       JSONB,                         -- set only when a fixed LLM judge scored this item
  deterministic_checks JSONB,                        -- schema/shape checks that don't need reference or a judge
  score               NUMERIC,
  latency_ms          INTEGER,
  cost_usd            NUMERIC,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  reasoning_tokens    INTEGER,
  served_model        TEXT,                          -- the model OpenRouter reports actually served this call
  is_byok             BOOLEAN,
  error               TEXT CHECK (error IS NULL OR error IN ('parse', 'api', 'empty')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, item_id)
);

CREATE INDEX idx_eval_results_run ON eval_results(run_id);
CREATE INDEX idx_eval_results_item ON eval_results(item_id);

-- RLS for the evaluation framework tables — no anon or authenticated policies (pipeline/reviewer
-- tooling, no known browser call site; service role bypasses RLS for scripts' reads/writes)
ALTER TABLE eval_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_results ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE eval_sets IS 'One frozen item sample for a task: how it was drawn (selection), from where (source), and the input hash it depends on. Items live in eval_items; variants run against it live in eval_runs.';
COMMENT ON COLUMN eval_sets.source IS 'Where the sample was drawn from. Free text, not a foreign key; shape varies by task: a batch id for audit/grading (e.g. capped-unit-1-2026-09-26), a bare unit id for mapping (e.g. unit-1), a markdown file path or display title for transcription.';
COMMENT ON COLUMN eval_sets.selection IS 'How the sample was drawn: strata, random seed, and any filters applied.';
COMMENT ON COLUMN eval_sets.inputs_hash IS 'Hash of the frozen inputs the items depend on (unit markdown content hash, units row hash); a mismatch on reuse means the underlying material changed since the set was created.';

COMMENT ON TABLE eval_items IS 'One item in an eval_sets sample: a frozen input snapshot (payload) plus an optional reviewer-assigned reference label. reference_status tracks review state independently of whether reference is populated.';
COMMENT ON COLUMN eval_items.item_key IS 'Stable identifier within its set (e.g. a question id or slide reference), unique per set, not globally.';
COMMENT ON COLUMN eval_items.payload IS 'The frozen input snapshot this item was sampled with: question fields, slide reference, answer, etc., depending on task.';
COMMENT ON COLUMN eval_items.seeded_class IS 'A design-time label: the class this item was constructed to carry when its set was built (grading: correct, typo, missing_accent, partially_correct, wrong, valid_paraphrase, and so on from GradingLabelClass; audit, once seeded: planted defects). Never a reviewer verdict; reference and reference_status remain the reviewed truth. Nullable, no CHECK constraint: the vocabulary is per task and will grow.';
COMMENT ON COLUMN eval_items.reference IS 'Reviewer-assigned labels for this item. Null until a reviewer labels it, regardless of reference_status.';

COMMENT ON TABLE eval_runs IS 'One variant, one execution: the model and settings under test, run against one eval_sets sample. summary holds the aggregate metrics computed once every item in the set has an eval_results row.';
COMMENT ON COLUMN eval_runs.task IS 'Copied from eval_sets.task at insert time by eval-run, the only writer today. Kept denormalized so a query can read task without a join. If a second writer of eval_runs rows is ever added, it must keep this in sync with the owning eval_sets row itself (a trigger) or this column should be dropped in favor of reading through the join.';
COMMENT ON COLUMN eval_runs.model IS 'Copied from the resolved eval_models.slug at insert time by eval-run, the only writer today, when model_version_id is set. Kept denormalized so a query can read model without a join. If a second writer of eval_runs rows is ever added, it must keep this in sync with the referenced eval_models row (a trigger) or this column should be dropped in favor of reading through the join.';
COMMENT ON COLUMN eval_runs.settings IS 'Call settings recorded with this variant: temperature, max_tokens, reasoning, provider pin, etc.; the same shape callLlm() accepts.';
COMMENT ON COLUMN eval_runs.judge_prompt_hash IS 'The hash of the most recent judge run on this row. A run can be judged against several others over time; this column reflects whichever judge call last ran, not any one pairing. The per-pairing hash that produced a specific verdict lives inside eval_results.judge_verdict itself, keyed alongside it.';
COMMENT ON COLUMN eval_runs.repeat_index IS 'Distinguishes repeated runs of the same variant on the same set, used to measure run-to-run noise for non-deterministic models.';
COMMENT ON COLUMN eval_runs.projected_cost_usd IS 'Estimated cost (item count times mean prompt size times list price) computed before the run started; the run refuses to start if this exceeds --max-cost.';

COMMENT ON TABLE eval_results IS 'One (run, item) pair: what the variant produced for that item, how it was scored, and its cost/latency/usage accounting.';
COMMENT ON COLUMN eval_results.judge_verdict IS 'Set only for items scored by a fixed LLM judge rather than direct comparison against eval_items.reference. Shape is { [otherRunId]: { [judgePromptHash]: [entry, ...] } }: nested under the judge prompt hash that produced it, so a re-judge of the same pair under a changed prompt adds a new list instead of overwriting the earlier one. Every eval-judge run appends one entry to the list for its pair and hash, so the same pair can be judged again, by the same judge model or another, and every earlier entry is kept. An entry is {outcome, judge_model, repeat, reasons, judged_at, judge_call, calls}: repeat is 0-based, the count of entries already in that list from the same judge model; judge_call is the settings the command sent ({provider_pin, reasoning, temperature}, a null provider_pin meaning unpinned and a null temperature meaning none was set); calls is one object per position order holding that call''s response id, finish reason and served model and host (never message content). Entries written before the call settings were recorded carry only outcome, judge_model, repeat, reasons and judged_at. reasons holds the judge model''s own sentence for each position order and may quote words from the slide or either transcript (course material, never a student''s text).';
COMMENT ON COLUMN eval_results.error IS 'Set when this item produced no usable output: parse (response didn''t parse or validate), api (the call itself failed), or empty (200 with no content). Null means the call succeeded and parsed.';

-- ============================================================
-- Evaluation framework: experiments, model registry, findings
-- The durable comparison layer over eval_sets/eval_items/eval_runs/eval_results:
-- a named question under test (eval_experiments), a dated model attribute
-- registry (eval_model_families/eval_models), an append-only record of what
-- was concluded (eval_findings), and reference-labeling campaigns
-- (eval_review_rounds). Same RLS posture as the four tables above: service
-- role only, no anon or authenticated policies.
-- ============================================================

CREATE TABLE eval_model_families (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor      TEXT NOT NULL,
  family      TEXT NOT NULL,        -- vendor + product line + size tier, never a version number; e.g. 'Claude Sonnet', 'GPT mini', 'Gemini Flash-Lite'
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (vendor, family)
);

CREATE TRIGGER eval_model_families_updated_at
  BEFORE UPDATE ON eval_model_families
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE eval_models (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                   UUID NOT NULL REFERENCES eval_model_families(id),
  slug                        TEXT NOT NULL,        -- OpenRouter model id, or 'direct:<name>' for a non-OpenRouter integration (e.g. Mistral OCR)
  effective_date              DATE NOT NULL,        -- the date these attributes were observed/fetched
  price_prompt_usd_per_m      NUMERIC,
  price_completion_usd_per_m  NUMERIC,
  context_window              INTEGER,
  max_completion_tokens       INTEGER,
  parameter_count_total       BIGINT,               -- published only; null for closed-weight vendors or when unpublished
  parameter_count_active      BIGINT,               -- for a mixture-of-experts model; equals parameter_count_total for a dense model when both are known, null if total itself is unknown
  architecture                TEXT CHECK (architecture IN ('dense', 'moe')),
  is_open_weight              BOOLEAN,
  training_data_size          TEXT,                 -- free text: rarely a single clean number, often unpublished
  release_date                DATE,                  -- the model's public release/announcement date (OpenRouter catalog's 'created')
  knowledge_cutoff             DATE,                  -- training data cutoff, distinct from release_date; usually vendor-stated, often unpublished
  modalities                  TEXT[] NOT NULL DEFAULT '{}', -- e.g. {text,image}
  json_mode                   BOOLEAN,
  structured_outputs          BOOLEAN,
  reasoning                   JSONB,                -- {default_on, mandatory, efforts: [...]}
  reasoning_class              TEXT GENERATED ALWAYS AS (
                                 CASE
                                   WHEN reasoning IS NULL THEN 'none'
                                   WHEN (reasoning ->> 'mandatory')::boolean IS TRUE THEN 'mandatory'
                                   WHEN (reasoning ->> 'default_on')::boolean IS TRUE THEN 'default_on'
                                   ELSE 'optional'
                                 END
                               ) STORED,
  batch_support               BOOLEAN,
  embedding_dimension         INTEGER,              -- set only for embedding models
  license                     TEXT,
  hosts                       JSONB NOT NULL DEFAULT '[]'::jsonb, -- known serving hosts: [{provider_pin, quantization, notes}]
  attribute_provenance        JSONB NOT NULL DEFAULT '{}'::jsonb, -- per-attribute exceptions to `source`, see comment
  source                      TEXT NOT NULL,         -- where this snapshot came from: a doc path or 'openrouter api fetch'
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (slug, effective_date)
);

CREATE INDEX idx_eval_models_family ON eval_models(family_id);

-- Shared by every append-only evaluation-framework table (eval_findings, eval_review_rounds):
-- blocks every UPDATE and DELETE unconditionally.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

-- eval_models allows UPDATE of notes and family_id only (a correction to either is legitimate — a
-- model can be reassigned to a different lineage after the fact); every other column change, and
-- any DELETE, is blocked. reasoning_class is excluded from the comparison because it is a GENERATED
-- ALWAYS column: inside a BEFORE trigger NEW's generated columns are not yet recomputed, so
-- comparing it here would always report a false difference; comparing reasoning itself (left in the
-- comparison) already covers any real change.
CREATE OR REPLACE FUNCTION eval_models_forbid_mutation() RETURNS trigger AS $$
DECLARE
  old_row eval_models;
  new_row eval_models;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'eval_models is append-only; DELETE is not permitted';
  END IF;
  old_row := OLD;
  new_row := NEW;
  old_row.notes := NULL;
  old_row.family_id := NULL;
  new_row.notes := NULL;
  new_row.family_id := NULL;
  old_row.reasoning_class := NULL;
  new_row.reasoning_class := NULL;
  IF old_row IS DISTINCT FROM new_row THEN
    RAISE EXCEPTION 'eval_models rows are append-only except notes and family_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

CREATE TRIGGER eval_models_append_only BEFORE UPDATE OR DELETE ON eval_models
  FOR EACH ROW EXECUTE FUNCTION eval_models_forbid_mutation();

CREATE VIEW eval_models_current WITH (security_invoker = true) AS
SELECT DISTINCT ON (slug) *
FROM eval_models
ORDER BY slug, effective_date DESC, created_at DESC;

CREATE TABLE eval_experiments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT NOT NULL UNIQUE,        -- descriptive public identifier, e.g. 'audit-single-vs-grouped'
  question            TEXT NOT NULL,               -- the falsifiable question this experiment answers
  tasks               TEXT[] NOT NULL,             -- usually one; a baseline sweep lists several
  variants_declared   JSONB NOT NULL DEFAULT '[]', -- [{label, model_slug, role, settings}, ...] planned before running
  decision_rule       JSONB NOT NULL DEFAULT '{}', -- numeric overrides (tolerance, precisionTolerance, maxSlideDrop) eval-compare resolves against the task default, plus description prose; empty means "use the task default"
  depends_on          TEXT[] NOT NULL DEFAULT '{}', -- experiment slugs this one depends on; informational, not FK-enforced
  status              TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'running', 'decided', 'deferred', 'superseded')),
  decided_at          TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT eval_experiments_tasks_valid CHECK (
    tasks <@ ARRAY['audit','grading','generation','validation','transcription','mapping']::text[]
  )
);

CREATE INDEX idx_eval_experiments_status ON eval_experiments(status);

CREATE TRIGGER eval_experiments_updated_at
  BEFORE UPDATE ON eval_experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE eval_findings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id         UUID REFERENCES eval_experiments(id),  -- nullable: a measurement-integrity fix or ad hoc finding may predate a numbered experiment
  kind                  TEXT NOT NULL CHECK (kind IN ('adopt', 'reject', 'defer', 'observation')),
  task                  TEXT CHECK (task IN ('audit','grading','generation','validation','transcription','mapping')),
  statement             TEXT NOT NULL,              -- the human-readable claim or decision
  evidence_note         TEXT,                       -- narrative detail a bare id list can't carry, e.g. "grouped wrong on 18 of 23 disagreements, singles wrong on 3"
  run_ids               UUID[] NOT NULL DEFAULT '{}', -- eval_runs.id cited as evidence
  item_ids              UUID[] NOT NULL DEFAULT '{}', -- eval_items.id cited as evidence
  external_refs         TEXT[] NOT NULL DEFAULT '{}', -- paths to markdown reports predating this table
  decided_by            TEXT,                       -- operator/reviewer handle; informational while there is one operator
  decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  supersedes_finding_id UUID REFERENCES eval_findings(id), -- set when this finding revises an earlier one; the earlier row is never edited
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eval_findings_experiment ON eval_findings(experiment_id);
CREATE INDEX idx_eval_findings_kind ON eval_findings(kind);

CREATE TRIGGER eval_findings_append_only BEFORE UPDATE OR DELETE ON eval_findings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE eval_review_rounds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  set_id                UUID NOT NULL REFERENCES eval_sets(id) ON DELETE RESTRICT,
  reviewer              TEXT NOT NULL,
  rubric_version        TEXT NOT NULL,         -- e.g. 'v1', the reviewer's rubric doc's own label
  rubric_hash           TEXT,                  -- content hash of the rubric at labeling time; stronger than rubric_version alone since a doc can change without a version bump
  calibration_result    JSONB,                 -- e.g. {"pilot_agreement": 0.92, "pilot_item_count": 20}
  inter_rater           JSONB,                 -- e.g. {"kappa": 0.81, "second_reviewer": "..."}; null with one reviewer, see below
  reviewed_item_count   INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eval_review_rounds_set ON eval_review_rounds(set_id);

CREATE TRIGGER eval_review_rounds_append_only BEFORE UPDATE OR DELETE ON eval_review_rounds
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE eval_runs
  ADD COLUMN experiment_id UUID REFERENCES eval_experiments(id),
  ADD COLUMN model_version_id UUID REFERENCES eval_models(id);

CREATE INDEX idx_eval_runs_experiment ON eval_runs(experiment_id);

ALTER TABLE eval_runs
  ADD COLUMN scored_at TIMESTAMPTZ,                  -- see COMMENT ON COLUMN below
  ADD COLUMN scoring_review_round_id UUID REFERENCES eval_review_rounds(id) ON DELETE RESTRICT;

COMMENT ON COLUMN eval_runs.scored_at IS 'When this run''s summary (and its results'' scores) were last computed, at run finalisation (eval-run) or by eval-rescore. Null for a run that never reached that step at all: one still running, or one whose outer failure handler marked it failed before any variant finalised. A run finalised as failed (every result errored, or the results write itself failed) still gets stamped, since finalizeVariant reached it.';

COMMENT ON COLUMN eval_runs.scoring_review_round_id IS 'The newest eval_review_rounds row on this run''s set at the time it was scored. Null when the set had no review round yet.';

ALTER TABLE eval_results
  ADD COLUMN served_provider TEXT;

-- Shared by eval_run_scorecard, eval_run_model_stats and eval_run_behaviour so the six-way
-- precedence lives in one place. STABLE, not IMMUTABLE: it reads eval_items and eval_review_rounds,
-- both of which change as items get reviewed. p_scored_at is the run's own eval_runs.scored_at
-- (null for a run that never reached that step); COALESCE'd against p_finished_at so a run with no
-- stamped scored_at still resolves "scored before references existed" the way it always did.
-- p_scoring_review_round_id is the run's own eval_runs.scoring_review_round_id (the round the
-- run was scored against, null when its set had none yet); a newer round on the set than that one,
-- or any round at all when the run's is null, also counts as "reference reviewed after scoring".
-- This is a second, independent signal alongside the reviewed_at comparison: a review round can be
-- recorded for a labeling campaign without every touched item's reviewed_at landing after
-- p_scored_at, so either signal catches a case the other misses.
CREATE OR REPLACE FUNCTION eval_run_metric_status(p_status text, p_summary jsonb, p_set_id uuid, p_finished_at timestamptz, p_scored_at timestamptz, p_scoring_review_round_id uuid) RETURNS text AS $$
  SELECT CASE
    WHEN p_status <> 'completed' THEN 'failed run'
    WHEN p_summary -> 'primary_metric' ->> 'value' IS NOT NULL
      AND (
        p_scored_at < (
          SELECT MAX(ei.reviewed_at) FROM eval_items ei WHERE ei.set_id = p_set_id AND ei.reference_status = 'approved'
        )
        OR EXISTS (
          SELECT 1 FROM eval_review_rounds rr
          WHERE rr.set_id = p_set_id
            AND (
              p_scoring_review_round_id IS NULL
              OR rr.created_at > (SELECT created_at FROM eval_review_rounds WHERE id = p_scoring_review_round_id)
            )
        )
      ) THEN 'reference reviewed after scoring'
    WHEN p_summary -> 'primary_metric' ->> 'value' IS NOT NULL THEN 'ok'
    WHEN NOT EXISTS (
      SELECT 1 FROM eval_items ei WHERE ei.set_id = p_set_id AND ei.reference_status = 'approved'
    ) THEN 'awaiting reviewed references'
    WHEN COALESCE(p_scored_at, p_finished_at) < (
      SELECT MIN(ei.reviewed_at) FROM eval_items ei WHERE ei.set_id = p_set_id AND ei.reference_status = 'approved'
    ) THEN 'scored before references existed'
    ELSE 'no primary metric'
  END;
$$ LANGUAGE sql STABLE
SET search_path = public;

COMMENT ON FUNCTION eval_run_metric_status(text, jsonb, uuid, timestamptz, timestamptz, uuid) IS 'Shared by eval_run_scorecard, eval_run_model_stats and eval_run_behaviour so the precedence that explains a null primary_metric lives in one place: failed run (p_status is not completed); reference reviewed after scoring (a metric is present, but either the set''s newest approved-item reviewed_at is later than p_scored_at, or an eval_review_rounds row on the set is newer than the one the run was scored against, including any round at all when the run was scored against none); ok (a metric is present and neither of those holds); awaiting reviewed references (the set has no approved reference item yet); scored before references existed (the run''s scored_at, or finished_at for a row with no stamped scored_at, predates the set''s earliest approved item''s reviewed_at); no primary metric (none of the above, worth investigating).';

-- Mirrors normalizeProviderName/normalizePin in apps/pipeline/src/lib/eval/compare/shared.ts:
-- lowercases, strips every character outside a-z0-9, and for a pin drops everything after the
-- first '/' (a host-routing suffix like 'mistral/zdr' that served_provider never echoes back)
-- before normalizing. Used by eval_run_model_stats.provider_mismatch_count so a hand-typed
-- --provider anthropic isn't flagged against OpenRouter's own 'Anthropic'.
CREATE OR REPLACE FUNCTION eval_normalize_provider(name text, is_pin boolean) RETURNS text AS $$
  SELECT regexp_replace(lower(CASE WHEN is_pin THEN split_part(name, '/', 1) ELSE name END), '[^a-z0-9]', '', 'g');
$$ LANGUAGE sql IMMUTABLE
SET search_path = public;

COMMENT ON FUNCTION eval_normalize_provider(text, boolean) IS 'Mirrors normalizeProviderName/normalizePin in apps/pipeline/src/lib/eval/compare/shared.ts: lowercases, strips every character outside a-z0-9, and for a pin (is_pin true) drops everything after the first ''/'' before normalizing. Used by eval_run_model_stats.provider_mismatch_count so a hand-typed --provider anthropic is not flagged against OpenRouter''s own ''Anthropic''.';

CREATE VIEW eval_run_scorecard WITH (security_invoker = true) AS
SELECT
  r.id                    AS run_id,
  r.task,
  r.experiment_id,
  x.slug                  AS experiment_slug,
  r.variant_label,
  r.repeat_index,
  r.model                 AS model_slug,
  fam.vendor,
  fam.family,
  m.effective_date        AS model_effective_date,
  m.price_prompt_usd_per_m,
  m.price_completion_usd_per_m,
  m.context_window,
  m.parameter_count_total,
  m.parameter_count_active,
  m.architecture,
  m.is_open_weight,
  m.release_date,
  m.knowledge_cutoff,
  m.reasoning,
  m.reasoning_class,
  r.status,
  r.started_at,
  r.finished_at,
  r.summary -> 'primary_metric' AS primary_metric,
  r.summary,
  eval_run_metric_status(r.status, r.summary, r.set_id, r.finished_at, r.scored_at, r.scoring_review_round_id) AS metric_status,
  r.scored_at,
  r.scoring_review_round_id
FROM eval_runs r
LEFT JOIN eval_experiments x ON x.id = r.experiment_id
LEFT JOIN eval_models m ON m.id = r.model_version_id
LEFT JOIN eval_model_families fam ON fam.id = m.family_id;

CREATE VIEW eval_model_history WITH (security_invoker = true) AS
SELECT
  s.model_slug, s.vendor, s.family, s.model_effective_date,
  s.price_prompt_usd_per_m, s.price_completion_usd_per_m, s.context_window,
  s.parameter_count_total, s.parameter_count_active, s.architecture, s.is_open_weight,
  s.task, s.experiment_slug, s.variant_label, s.primary_metric, s.started_at
FROM eval_run_scorecard s
ORDER BY s.model_slug, s.started_at;

CREATE VIEW eval_run_model_stats WITH (security_invoker = true) AS
SELECT
  r.id                        AS run_id,
  r.task,
  r.experiment_id,
  r.variant_label,
  r.repeat_index,
  r.provider_pin,
  (r.summary -> 'primary_metric' ->> 'value')::numeric AS primary_metric_value,
  r.summary -> 'primary_metric' ->> 'name'              AS primary_metric_name,
  agg.mean_cost_usd,
  agg.mean_latency_ms,
  agg.result_count,
  agg.error_count,
  agg.provider_mismatch_count,
  CASE WHEN (r.summary -> 'primary_metric' ->> 'value')::numeric > 0
       THEN agg.mean_cost_usd / (r.summary -> 'primary_metric' ->> 'value')::numeric END
                               AS cost_per_metric_unit,
  m.id                        AS model_version_id,
  m.slug                      AS model_slug,
  fam.vendor,
  m.family_id,
  fam.family,
  m.effective_date            AS model_effective_date,
  m.price_prompt_usd_per_m,
  m.price_completion_usd_per_m,
  m.context_window,
  m.parameter_count_total,
  m.parameter_count_active,
  m.architecture,
  m.is_open_weight,
  m.release_date,
  m.knowledge_cutoff,
  m.reasoning_class,
  eval_run_metric_status(r.status, r.summary, r.set_id, r.finished_at, r.scored_at, r.scoring_review_round_id) AS metric_status
FROM eval_runs r
LEFT JOIN eval_models m ON m.id = r.model_version_id
LEFT JOIN eval_model_families fam ON fam.id = m.family_id
LEFT JOIN LATERAL (
  SELECT
    avg(res.cost_usd)                                              AS mean_cost_usd,
    avg(res.latency_ms)                                            AS mean_latency_ms,
    count(*)                                                       AS result_count,
    count(*) FILTER (WHERE res.error IS NOT NULL)                  AS error_count,
    count(*) FILTER (WHERE res.served_provider IS NOT NULL
                       AND r.provider_pin IS NOT NULL
                       AND eval_normalize_provider(res.served_provider, false)
                           IS DISTINCT FROM eval_normalize_provider(r.provider_pin, true))
                                                                     AS provider_mismatch_count
  FROM eval_results res WHERE res.run_id = r.id
) agg ON true;

CREATE VIEW eval_family_history WITH (security_invoker = true) AS
SELECT
  fam.id      AS family_id,
  fam.vendor,
  fam.family,
  s.model_slug, s.model_effective_date, s.parameter_count_total, s.parameter_count_active,
  s.architecture, s.is_open_weight, s.reasoning_class,
  s.task, s.primary_metric_name, s.primary_metric_value,
  s.mean_cost_usd, s.mean_latency_ms, s.run_id,
  s.metric_status
FROM eval_model_families fam
JOIN eval_models m ON m.family_id = fam.id
JOIN eval_run_model_stats s ON s.model_version_id = m.id
ORDER BY fam.family, s.model_effective_date, s.run_id;

-- The per-task verdict eval_item_consensus and eval_run_pair_agreement both compare, factored into
-- one function so the two cannot drift. See eval_item_consensus's own comment for what each task's
-- case means. IMMUTABLE: a pure function of its three arguments, reading no table.
CREATE OR REPLACE FUNCTION eval_result_verdict(p_task text, p_output jsonb, p_deterministic_checks jsonb) RETURNS jsonb AS $$
  SELECT CASE p_task
    WHEN 'grading' THEN jsonb_build_object('is_correct', p_output ->> 'isCorrect')
    WHEN 'audit' THEN jsonb_build_object(
      'answer_correct', p_output ->> 'answer_correct',
      'grammar_correct', p_output ->> 'grammar_correct',
      'no_hallucination', p_output ->> 'no_hallucination',
      'question_coherent', p_output ->> 'question_coherent',
      'natural_language', p_output ->> 'natural_language',
      'register_appropriate', p_output ->> 'register_appropriate'
    )
    WHEN 'mapping' THEN jsonb_build_object('headings', (
      SELECT COALESCE(jsonb_agg(heading ORDER BY heading), '[]'::jsonb)
      FROM (
        SELECT DISTINCT elem ->> 'heading' AS heading
        FROM jsonb_array_elements(COALESCE(p_output -> 'headings', '[]'::jsonb)) elem
      ) distinct_headings
    ))
    WHEN 'transcription' THEN jsonb_build_object(
      'no_content_marker', p_deterministic_checks ->> 'no_content_marker'
    )
  END;
$$ LANGUAGE sql IMMUTABLE
SET search_path = public;

COMMENT ON FUNCTION eval_result_verdict(text, jsonb, jsonb) IS 'The per-task verdict compared by eval_item_consensus and eval_run_pair_agreement, factored out so the two cannot drift. grading is is_correct from output->>''isCorrect''; audit is the six gate-criteria booleans together; mapping is the sorted, de-duplicated set of heading strings returned; transcription is the no-content-marker decision alone. Null for a task with no case here (generation, validation, which have no runner).';

-- The human-review worklist: how much a task's completed, non-error runs agree on each item.
-- The per-result verdict compared is eval_result_verdict (see its comment for the per-task cases).
CREATE VIEW eval_item_consensus WITH (security_invoker = true) AS
WITH result_verdicts AS (
  SELECT
    ei.id AS item_id,
    eval_result_verdict(es.task, er.output, er.deterministic_checks) AS verdict
  FROM eval_results er
  JOIN eval_runs r ON r.id = er.run_id
  JOIN eval_items ei ON ei.id = er.item_id
  JOIN eval_sets es ON es.id = ei.set_id
  WHERE r.status = 'completed' AND er.error IS NULL
),
item_totals AS (
  SELECT item_id, count(*) AS run_count, count(DISTINCT verdict) AS verdict_count
  FROM result_verdicts
  WHERE verdict IS NOT NULL
  GROUP BY item_id
),
item_majority AS (
  SELECT item_id, max(n) AS majority_count
  FROM (
    SELECT item_id, verdict, count(*) AS n
    FROM result_verdicts
    WHERE verdict IS NOT NULL
    GROUP BY item_id, verdict
  ) verdict_counts
  GROUP BY item_id
)
SELECT
  ei.id                                             AS item_id,
  es.task,
  ei.item_key,
  ei.set_id,
  es.unit_id,
  (ei.reference_status = 'approved')                AS has_approved_reference,
  t.run_count,
  t.verdict_count,
  round(m.majority_count::numeric / t.run_count, 4) AS majority_share,
  ei.seeded_class
FROM item_totals t
JOIN item_majority m ON m.item_id = t.item_id
JOIN eval_items ei ON ei.id = t.item_id
JOIN eval_sets es ON es.id = ei.set_id
WHERE t.run_count >= 2;

-- Reference-free run behaviour: what a run measurably did, read from eval_results rather than the
-- run's own summary, so it stays correct for a run whose summary predates a rescore. Ranks audit
-- and grading variants while their references are still pending.
CREATE VIEW eval_run_behaviour WITH (security_invoker = true) AS
SELECT
  r.id                AS run_id,
  r.task,
  r.set_id,
  r.experiment_id,
  r.variant_label,
  r.model,
  r.repeat_index,
  agg.result_count,
  agg.error_count,
  agg.parse_failure_rate,
  agg.mean_cost_usd,
  agg.latency_ms_p50,
  agg.latency_ms_p95,
  agg.task_behaviour,
  eval_run_metric_status(r.status, r.summary, r.set_id, r.finished_at, r.scored_at, r.scoring_review_round_id) AS metric_status
FROM eval_runs r
CROSS JOIN LATERAL (
  SELECT
    count(*)                                                     AS result_count,
    count(*) FILTER (WHERE er.error IS NOT NULL)                 AS error_count,
    (count(*) FILTER (WHERE er.error = 'parse'))::numeric
      / nullif(count(*), 0)                                      AS parse_failure_rate,
    avg(er.cost_usd)                                              AS mean_cost_usd,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY er.latency_ms)   AS latency_ms_p50,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY er.latency_ms)   AS latency_ms_p95,
    CASE r.task
      WHEN 'audit' THEN jsonb_build_object(
        'answer_correct', (count(*) FILTER (WHERE (er.output ->> 'answer_correct') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'answer_correct'), 0),
        'grammar_correct', (count(*) FILTER (WHERE (er.output ->> 'grammar_correct') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'grammar_correct'), 0),
        'no_hallucination', (count(*) FILTER (WHERE (er.output ->> 'no_hallucination') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'no_hallucination'), 0),
        'question_coherent', (count(*) FILTER (WHERE (er.output ->> 'question_coherent') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'question_coherent'), 0),
        'natural_language', (count(*) FILTER (WHERE (er.output ->> 'natural_language') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'natural_language'), 0),
        'register_appropriate', (count(*) FILTER (WHERE (er.output ->> 'register_appropriate') = 'false'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'register_appropriate'), 0)
      )
      WHEN 'grading' THEN jsonb_build_object(
        'share_marked_correct', (count(*) FILTER (WHERE (er.output ->> 'isCorrect') = 'true'))::numeric
          / nullif(count(*) FILTER (WHERE er.output ? 'isCorrect'), 0)
      )
      WHEN 'mapping' THEN jsonb_build_object(
        'mean_headings_per_topic', avg(
          (SELECT count(*) FROM jsonb_array_elements(COALESCE(er.output -> 'headings', '[]'::jsonb)))
        ) FILTER (WHERE er.error IS NULL),
        'unresolved_count', sum(COALESCE((er.deterministic_checks ->> 'unresolved')::int, 0))
      )
      WHEN 'transcription' THEN jsonb_build_object(
        'no_content_marker_rate', (count(*) FILTER (WHERE er.output IS NOT NULL
          AND (er.deterministic_checks ->> 'no_content_marker') = 'true'))::numeric
          / nullif(count(*) FILTER (WHERE er.output IS NOT NULL), 0),
        'mean_coverage', avg((er.deterministic_checks ->> 'coverage')::numeric)
      )
    END AS task_behaviour
  FROM eval_results er
  WHERE er.run_id = r.id
) agg
WHERE r.status = 'completed';

-- Variant-identity grouping for repeat stability, the SQL twin of normalizeRepeatIdentitySettings
-- in apps/pipeline/src/commands/eval-run.ts. Must change with it: a drift here silently changes
-- which runs count as repeats of each other.
CREATE VIEW eval_variant_stability WITH (security_invoker = true) AS
WITH run_identity AS (
  SELECT
    r.id                                                   AS run_id,
    r.experiment_id,
    r.set_id,
    r.model,
    r.prompt_hash,
    (r.summary -> 'primary_metric' ->> 'value')::numeric    AS primary_metric_value,
    CASE WHEN r.settings ? 'temperature' THEN r.settings -> 'temperature'
         ELSE '"__temperature_not_sent__"'::jsonb END        AS norm_temperature,
    COALESCE(r.settings -> 'reasoning', 'null'::jsonb)       AS norm_reasoning,
    CASE
      WHEN r.settings -> 'provider' IS NULL OR jsonb_typeof(r.settings -> 'provider') = 'null' THEN 'null'::jsonb
      WHEN r.settings -> 'provider' -> 'order' IS NULL THEN r.settings -> 'provider'
      ELSE (r.settings -> 'provider') || jsonb_build_object(
        'order', (
          SELECT COALESCE(jsonb_agg(lower(o)), '[]'::jsonb)
          FROM jsonb_array_elements_text(r.settings -> 'provider' -> 'order') o
        )
      )
    END                                                      AS norm_provider,
    COALESCE(r.settings -> 'groupSize', '1'::jsonb)          AS norm_group_size,
    COALESCE(r.settings -> 'shuffleSeed', 'null'::jsonb)     AS norm_shuffle_seed,
    COALESCE(r.settings -> 'exclusionPass', 'null'::jsonb)   AS norm_exclusion_pass,
    COALESCE(r.settings -> 'renderDpi', '120'::jsonb)        AS norm_render_dpi,
    COALESCE(r.settings -> 'mode', '"sync"'::jsonb)          AS norm_mode,
    COALESCE(r.settings -> 'grouping', '"by_order"'::jsonb)  AS norm_grouping,
    (SELECT avg(cost_usd) FROM eval_results WHERE run_id = r.id) AS mean_cost_usd
  FROM eval_runs r
  WHERE r.status NOT IN ('failed', 'aborted')
)
SELECT
  experiment_id,
  set_id,
  model,
  prompt_hash,
  norm_temperature    AS temperature,
  norm_reasoning       AS reasoning,
  norm_provider        AS provider,
  norm_group_size      AS group_size,
  norm_shuffle_seed    AS shuffle_seed,
  norm_exclusion_pass  AS exclusion_pass,
  norm_render_dpi      AS render_dpi,
  norm_mode            AS mode,
  norm_grouping        AS grouping,
  count(*)                                                AS run_count,
  avg(primary_metric_value)                               AS mean_primary_metric_value,
  (max(primary_metric_value) - min(primary_metric_value)) AS primary_metric_spread,
  avg(mean_cost_usd)                                      AS mean_cost_usd,
  array_agg(run_id ORDER BY run_id)                       AS run_ids
FROM run_identity
GROUP BY experiment_id, set_id, model, prompt_hash, norm_temperature, norm_reasoning, norm_provider,
         norm_group_size, norm_shuffle_seed, norm_exclusion_pass, norm_render_dpi, norm_mode, norm_grouping;

-- Declared-vs-run variant composition: one row per planned variant, joined to the runs that exist
-- for it today. A run matches a declared variant when it belongs to the experiment whose runs the
-- declaration draws on (the declaring experiment, or the experiment named by baseline_from), its
-- model equals the declared model_slug and, for every settings key the declaration carries, the
-- run's own settings normalize to the same value (the normalization is the per-run half of the same
-- rule eval_variant_stability groups by, inlined here rather than shared, since that view also
-- filters and groups by other columns this one does not need). A declaration naming no model_slug
-- (or '*') matches nothing. declaredVariantMatchesRun in apps/pipeline/src/commands/eval-run.ts is
-- the TypeScript twin of this match rule and must change with it.
CREATE VIEW eval_experiment_variants WITH (security_invoker = true) AS
WITH run_identity AS (
  SELECT
    r.id                                                    AS run_id,
    r.experiment_id,
    r.model,
    CASE WHEN r.settings ? 'temperature' THEN r.settings -> 'temperature'
         ELSE '"__temperature_not_sent__"'::jsonb END        AS norm_temperature,
    COALESCE(r.settings -> 'reasoning', 'null'::jsonb)       AS norm_reasoning,
    CASE
      WHEN r.settings -> 'provider' IS NULL OR jsonb_typeof(r.settings -> 'provider') = 'null' THEN 'null'::jsonb
      WHEN r.settings -> 'provider' -> 'order' IS NULL THEN r.settings -> 'provider'
      ELSE (r.settings -> 'provider') || jsonb_build_object(
        'order', (
          SELECT COALESCE(jsonb_agg(lower(o)), '[]'::jsonb)
          FROM jsonb_array_elements_text(r.settings -> 'provider' -> 'order') o
        )
      )
    END                                                       AS norm_provider,
    COALESCE(r.settings -> 'groupSize', '1'::jsonb)          AS norm_group_size,
    COALESCE(r.settings -> 'shuffleSeed', 'null'::jsonb)     AS norm_shuffle_seed,
    CASE
      WHEN r.settings -> 'exclusionPass' IS NULL OR jsonb_typeof(r.settings -> 'exclusionPass') = 'null' THEN 'null'::jsonb
      WHEN jsonb_typeof(r.settings -> 'exclusionPass') = 'object' THEN COALESCE(r.settings -> 'exclusionPass' -> 'model', 'null'::jsonb)
      ELSE r.settings -> 'exclusionPass'
    END                                                       AS norm_exclusion_pass,
    COALESCE(r.settings -> 'renderDpi', '120'::jsonb)        AS norm_render_dpi,
    COALESCE(r.settings -> 'mode', '"sync"'::jsonb)          AS norm_mode,
    COALESCE(r.settings -> 'grouping', '"by_order"'::jsonb)  AS norm_grouping
  FROM eval_runs r
  WHERE r.status NOT IN ('failed', 'aborted')
),
variants AS (
  SELECT
    e.id                             AS experiment_id,
    e.slug                           AS experiment_slug,
    v.ord                            AS variant_ord,
    v.declared ->> 'label'           AS declared_label,
    v.declared ->> 'model_slug'      AS model_slug,
    v.declared ->> 'role'            AS role,
    v.declared ->> 'baseline_from'   AS baseline_from,
    CASE
      WHEN v.declared ->> 'baseline_from' IS NULL THEN e.id
      ELSE (SELECT x.id FROM eval_experiments x WHERE x.slug = v.declared ->> 'baseline_from')
    END                              AS candidate_experiment_id,
    COALESCE(v.declared -> 'settings', '{}'::jsonb) AS declared_settings
  FROM eval_experiments e
  CROSS JOIN LATERAL jsonb_array_elements(e.variants_declared) WITH ORDINALITY AS v(declared, ord)
),
variant_runs AS (
  SELECT va.experiment_id, va.variant_ord, ri.run_id
  FROM variants va
  JOIN run_identity ri
    ON ri.experiment_id = va.candidate_experiment_id
    AND ri.model = va.model_slug
    AND va.model_slug IS NOT NULL AND va.model_slug <> '*'
    AND (NOT (va.declared_settings ? 'temperature') OR ri.norm_temperature = va.declared_settings -> 'temperature')
    AND (NOT (va.declared_settings ? 'reasoning') OR ri.norm_reasoning = va.declared_settings -> 'reasoning')
    AND (NOT (va.declared_settings ? 'provider') OR ri.norm_provider = (
          CASE
            WHEN va.declared_settings -> 'provider' -> 'order' IS NULL THEN va.declared_settings -> 'provider'
            ELSE (va.declared_settings -> 'provider') || jsonb_build_object(
              'order', (
                SELECT COALESCE(jsonb_agg(lower(o)), '[]'::jsonb)
                FROM jsonb_array_elements_text(va.declared_settings -> 'provider' -> 'order') o
              )
            )
          END
        ))
    AND (NOT (va.declared_settings ? 'groupSize') OR ri.norm_group_size = va.declared_settings -> 'groupSize')
    AND (NOT (va.declared_settings ? 'shuffleSeed') OR ri.norm_shuffle_seed = va.declared_settings -> 'shuffleSeed')
    AND (NOT (va.declared_settings ? 'exclusionPass') OR ri.norm_exclusion_pass = (
          CASE
            WHEN va.declared_settings -> 'exclusionPass' IS NULL OR jsonb_typeof(va.declared_settings -> 'exclusionPass') = 'null' THEN 'null'::jsonb
            WHEN jsonb_typeof(va.declared_settings -> 'exclusionPass') = 'object' THEN COALESCE(va.declared_settings -> 'exclusionPass' -> 'model', 'null'::jsonb)
            ELSE va.declared_settings -> 'exclusionPass'
          END
        ))
    AND (NOT (va.declared_settings ? 'renderDpi') OR ri.norm_render_dpi = va.declared_settings -> 'renderDpi')
    AND (NOT (va.declared_settings ? 'mode') OR ri.norm_mode = va.declared_settings -> 'mode')
    AND (NOT (va.declared_settings ? 'grouping') OR ri.norm_grouping = va.declared_settings -> 'grouping')
),
shared_runs AS (
  SELECT experiment_id, run_id
  FROM variant_runs
  GROUP BY experiment_id, run_id
  HAVING count(DISTINCT variant_ord) > 1
)
SELECT
  va.experiment_id,
  va.experiment_slug,
  va.declared_label,
  va.model_slug,
  va.role,
  CASE
    WHEN va.model_slug IS NULL OR va.model_slug = '*' THEN NULL
    ELSE EXISTS (
      SELECT 1 FROM variant_runs vr
      JOIN shared_runs sr ON sr.experiment_id = vr.experiment_id AND sr.run_id = vr.run_id
      WHERE vr.experiment_id = va.experiment_id AND vr.variant_ord = va.variant_ord
    )
  END                                                       AS ambiguous,
  COALESCE(rr.run_count, 0)                                 AS run_count,
  COALESCE(rr.run_ids, '{}')                                AS run_ids,
  va.baseline_from                                          AS runs_from_slug
FROM variants va
LEFT JOIN LATERAL (
  SELECT count(*) AS run_count, array_agg(vr.run_id ORDER BY vr.run_id) AS run_ids
  FROM variant_runs vr
  WHERE vr.experiment_id = va.experiment_id AND vr.variant_ord = va.variant_ord
) rr ON true;

-- Dependency status: one row per depends_on entry, with the named experiment's current status.
CREATE VIEW eval_experiment_dependencies WITH (security_invoker = true) AS
SELECT
  e.id                          AS experiment_id,
  e.slug                        AS experiment_slug,
  dep.slug                      AS depends_on_slug,
  COALESCE(d.status, 'missing') AS depends_on_status
FROM eval_experiments e
CROSS JOIN LATERAL unnest(e.depends_on) AS dep(slug)
LEFT JOIN eval_experiments d ON d.slug = dep.slug;

-- One row of header counts for the dashboard: how much is in each table and how it splits by
-- status or kind, read directly rather than re-derived from several hand-written queries.
CREATE VIEW eval_overview WITH (security_invoker = true) AS
SELECT
  (SELECT count(*) FROM eval_sets)                                        AS sets,
  (SELECT count(*) FROM eval_items)                                       AS items,
  (SELECT count(*) FROM eval_items WHERE reference_status = 'approved')   AS items_with_approved_reference,
  (SELECT count(*) FROM eval_runs WHERE status = 'running')               AS runs_running,
  (SELECT count(*) FROM eval_runs WHERE status = 'completed')             AS runs_completed,
  (SELECT count(*) FROM eval_runs WHERE status = 'failed')                AS runs_failed,
  (SELECT count(*) FROM eval_runs WHERE status = 'aborted')               AS runs_aborted,
  (SELECT count(*) FROM eval_results)                                     AS results,
  (SELECT count(*) FROM eval_experiments WHERE status = 'proposed')       AS experiments_proposed,
  (SELECT count(*) FROM eval_experiments WHERE status = 'running')        AS experiments_running,
  (SELECT count(*) FROM eval_experiments WHERE status = 'decided')        AS experiments_decided,
  (SELECT count(*) FROM eval_experiments WHERE status = 'deferred')       AS experiments_deferred,
  (SELECT count(*) FROM eval_experiments WHERE status = 'superseded')     AS experiments_superseded,
  (SELECT count(*) FROM eval_findings WHERE kind = 'adopt')               AS findings_adopt,
  (SELECT count(*) FROM eval_findings WHERE kind = 'reject')              AS findings_reject,
  (SELECT count(*) FROM eval_findings WHERE kind = 'defer')               AS findings_defer,
  (SELECT count(*) FROM eval_findings WHERE kind = 'observation')         AS findings_observation,
  (SELECT count(*) FROM eval_models_current)                              AS registered_models;

COMMENT ON VIEW eval_overview IS 'One row of header counts for the dashboard: eval_sets, eval_items (total and with an approved reference), eval_runs by status, eval_results, eval_experiments by status, eval_findings by kind, and eval_models_current (the latest snapshot per registered model slug). Every count is a direct count(*) on its table, or that count filtered by status or kind; nothing here is derived from another view.';

-- The findings feed with a superseded chain collapsed to its most recent link: when a finding
-- supersedes an earlier one, and that one may itself supersede a still earlier one, only the chain
-- head (the one nothing else supersedes) is shown, with the chain's length and the ids it
-- supersedes carried alongside it. A finding nobody has superseded is a chain of one.
CREATE VIEW eval_findings_current WITH (security_invoker = true) AS
WITH RECURSIVE chain AS (
  SELECT f.id AS head_id, f.id AS node_id, f.supersedes_finding_id, 1 AS depth
  FROM eval_findings f
  WHERE NOT EXISTS (SELECT 1 FROM eval_findings s WHERE s.supersedes_finding_id = f.id)
  UNION ALL
  SELECT c.head_id, p.id AS node_id, p.supersedes_finding_id, c.depth + 1
  FROM chain c
  JOIN eval_findings p ON p.id = c.supersedes_finding_id
),
chain_agg AS (
  SELECT
    head_id,
    max(depth)                                                            AS chain_length,
    array_agg(node_id ORDER BY node_id) FILTER (WHERE node_id <> head_id)  AS superseded_finding_ids
  FROM chain
  GROUP BY head_id
)
SELECT
  f.id,
  f.kind,
  f.experiment_id,
  x.slug AS experiment_slug,
  f.task,
  f.statement,
  f.evidence_note,
  f.decided_by,
  f.decided_at,
  f.run_ids,
  f.item_ids,
  ca.chain_length,
  COALESCE(ca.superseded_finding_ids, '{}') AS superseded_finding_ids
FROM chain_agg ca
JOIN eval_findings f ON f.id = ca.head_id
LEFT JOIN eval_experiments x ON x.id = f.experiment_id
ORDER BY f.decided_at DESC;

COMMENT ON VIEW eval_findings_current IS 'eval_findings with a superseded chain (supersedes_finding_id, possibly several links deep) collapsed to its most recent link. chain_length counts every finding in the chain including the head; superseded_finding_ids lists the earlier ones it replaces, empty for a finding nobody has superseded. Has exactly as many fewer rows than eval_findings as there are superseded (non-head) findings. Ordered newest first by decided_at, the order a reader of the feed wants.';

-- One row per experiment: how much has run against it, what was concluded, and whether its
-- declared plan and its dependencies are caught up with reality. declared_variants_with_runs and
-- undecided_dependency_count read eval_experiment_variants and eval_experiment_dependencies rather
-- than re-deriving either view's own matching rule here; the finding columns read
-- eval_findings_current for the current view of what was concluded.
CREATE VIEW eval_experiment_summary WITH (security_invoker = true) AS
SELECT
  e.id                                     AS experiment_id,
  e.slug,
  e.status,
  e.tasks,
  e.question,
  e.decision_rule,
  (SELECT count(*) FROM eval_runs r WHERE r.experiment_id = e.id)     AS run_count,
  (SELECT count(*) FROM eval_findings f WHERE f.experiment_id = e.id) AS finding_count,
  lf.kind                                  AS latest_finding_kind,
  lf.decided_at                            AS latest_finding_at,
  jsonb_array_length(e.variants_declared)  AS declared_variant_count,
  (SELECT count(*) FROM eval_experiment_variants v
    WHERE v.experiment_id = e.id AND v.run_count > 0)                 AS declared_variants_with_runs,
  (SELECT count(*) FROM eval_experiment_dependencies d
    WHERE d.experiment_id = e.id AND d.depends_on_status <> 'decided') AS undecided_dependency_count,
  (SELECT count(*) FROM eval_findings_current c WHERE c.experiment_id = e.id) AS current_finding_count
FROM eval_experiments e
LEFT JOIN LATERAL (
  SELECT c.kind, c.decided_at
  FROM eval_findings_current c
  WHERE c.experiment_id = e.id
  ORDER BY c.decided_at DESC
  LIMIT 1
) lf ON true;

COMMENT ON VIEW eval_experiment_summary IS 'One row per experiment: its own columns, how many eval_runs cite it (run_count), and its findings. finding_count is the raw count of every eval_findings row citing it, superseded ones included; current_finding_count counts eval_findings_current rows, where a superseded chain counts once as its head. latest_finding_kind and latest_finding_at come from the newest eval_findings_current row, so a superseded finding never ranks as latest. declared_variant_count is how many variants it declared (variants_declared); declared_variants_with_runs is how many of those have at least one matching run (eval_experiment_variants.run_count > 0), and a declared baseline that carries baseline_from counts the runs of the experiment it names, so a shared baseline counts as having run. undecided_dependency_count is how many of its eval_experiment_dependencies entries name a dependency whose own status is not ''decided'' (proposed, running, deferred, superseded, or missing all count as undecided).';

-- Every unordered pair of completed runs on the same set: how many items both scored without
-- error, and the share of those where they reached the same per-task verdict
-- (eval_result_verdict, the same expression eval_item_consensus uses; verdict_kind names what that
-- verdict is for the pair's task). Generalizes the dashboard
-- snapshot's grading_pairwise_agreement dataset to every task, not only grading.
CREATE VIEW eval_run_pair_agreement WITH (security_invoker = true) AS
WITH completed_runs AS (
  SELECT r.id AS run_id, r.set_id, r.variant_label, r.model, es.task
  FROM eval_runs r
  JOIN eval_sets es ON es.id = r.set_id
  WHERE r.status = 'completed'
),
verdicts AS (
  SELECT er.run_id, er.item_id,
    eval_result_verdict(cr.task, er.output, er.deterministic_checks) AS verdict
  FROM eval_results er
  JOIN completed_runs cr ON cr.run_id = er.run_id
  WHERE er.error IS NULL
)
SELECT
  a.set_id,
  a.task,
  a.run_id        AS run_id_a,
  a.variant_label AS variant_label_a,
  a.model         AS model_a,
  b.run_id        AS run_id_b,
  b.variant_label AS variant_label_b,
  b.model         AS model_b,
  count(*)                                                       AS n,
  count(*) FILTER (WHERE va.verdict = vb.verdict)                AS agree_count,
  round(count(*) FILTER (WHERE va.verdict = vb.verdict)::numeric
    / nullif(count(*), 0), 4)                                    AS agreement_rate,
  CASE a.task
    WHEN 'grading' THEN 'is_correct'
    WHEN 'audit' THEN 'gate_criteria'
    WHEN 'mapping' THEN 'headings'
    WHEN 'transcription' THEN 'no_content_marker'
  END                                                            AS verdict_kind
FROM completed_runs a
JOIN completed_runs b ON b.set_id = a.set_id AND a.run_id < b.run_id
JOIN verdicts va ON va.run_id = a.run_id
JOIN verdicts vb ON vb.run_id = b.run_id AND vb.item_id = va.item_id
GROUP BY a.set_id, a.task, a.run_id, a.variant_label, a.model, b.run_id, b.variant_label, b.model;

COMMENT ON VIEW eval_run_pair_agreement IS 'One row per unordered pair of completed runs on the same eval_sets row (a.run_id < b.run_id so each pair appears once). n is the number of items both runs scored without error; agree_count and agreement_rate compare eval_result_verdict(task, output, deterministic_checks) between the two, the same verdict eval_item_consensus uses. For the grading task this reproduces the dashboard snapshot''s grading_pairwise_agreement numbers; unlike that dataset, this view covers every task, not only grading. verdict_kind names what that verdict is, per task, using the branch names of eval_result_verdict: is_correct (grading: the is-correct decision), gate_criteria (audit: the six gate-criteria booleans together), headings (mapping: the set of heading strings returned) and no_content_marker (transcription: whether the run''s output for the slide was exactly the no-content marker). agreement_rate is therefore agreement on different things for different tasks and is only comparable within one verdict_kind; for transcription it measures agreement on the no-content marker, not on how similar the two transcripts are.';

-- RLS for the experiment/model-registry/findings tables — no anon or authenticated
-- policies, same rationale as the eval tables above
ALTER TABLE eval_model_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE eval_review_rounds ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE eval_model_families IS 'A stable lineage of eval_models snapshots that share a name across versions (e.g. every Claude Sonnet release), so a longitudinal view can group by family across slug changes. Deliberately thin: vendor and a family label only. Populated by hand via the table editor. Not append-only: a family grouping is expected to be corrected later, so it gets updated_at/the set_updated_at trigger like eval_experiments, not the append-only treatment eval_findings/eval_models/eval_review_rounds get. The family column names a lineage, not a release: vendor + product line + size tier, never a version number. Right: "Claude Sonnet", "GPT mini", "Gemini Flash-Lite". Wrong: "GPT-4.1", "Mistral Medium 3.5" (a version number folded into the name defeats the point of a lineage that is supposed to span versions).';
COMMENT ON COLUMN eval_model_families.family IS 'Vendor + product line + size tier, never a version number. Right: "Claude Sonnet", "GPT mini", "Gemini Flash-Lite". Wrong: "GPT-4.1", "Mistral Medium 3.5".';

COMMENT ON TABLE eval_models IS 'One dated snapshot of a model''s attributes. Append-only except for notes and family_id, enforced by a trigger: a correction to notes or family_id is a normal UPDATE, but a correction to any other attribute (a wrong price, a wrong context window) is a new dated row at a new effective_date, the same as a routine catalog refresh, because OpenRouter slugs silently repoint to different underlying weights or pricing. Runs reference a specific row via eval_runs.model_version_id, not a bare slug.';
COMMENT ON COLUMN eval_models.slug IS 'The identity a run declares it wants. What a given call actually served is eval_results.served_model, which remains the per-call ground truth this table does not replace.';
COMMENT ON COLUMN eval_models.family_id IS 'Groups this snapshot with other versions of the same lineage for longitudinal queries (eval_family_history), and is this row''s only route to vendor (eval_models has no vendor column of its own). NOT NULL: every snapshot gets a family row at insert time, even a one-member placeholder for a model outside the curated lineage list, rather than leaving vendor unrecoverable for that row.';
COMMENT ON COLUMN eval_models.parameter_count_active IS 'A mixture-of-experts model''s active parameter count per token, distinct from its total. Populated for a dense model too (equal to parameter_count_total) when both are known, so a regression against "active parameters" reads uniformly across architectures without a per-row NULL/architecture branch.';
COMMENT ON COLUMN eval_models.architecture IS 'dense or moe, where publicly known. Null, not a third value, when the architecture itself is unpublished (most closed-weight vendors don''t state this).';
COMMENT ON COLUMN eval_models.reasoning_class IS 'Generated, not independently entered: a plain column here would let a hand-entered eval_models row via the Supabase table editor set reasoning and reasoning_class inconsistently, with nothing to catch it. Pure function of reasoning: none when reasoning IS NULL; mandatory when reasoning->>''mandatory'' is true; default_on when reasoning->>''default_on'' is true and not mandatory; optional otherwise (reasoning is supported but neither default nor required). Exists so a grouped-stats query can GROUP BY reasoning_class directly instead of re-parsing the reasoning JSONB in every query that wants this cut.';
COMMENT ON COLUMN eval_models.hosts IS 'This model version''s known serving hosts, each an object {provider_pin, quantization, notes}. A host serving a reduced-precision build (e.g. the ''nebius/fp8'' pin style) is endpoint metadata on this row, not a separate eval_models row: the underlying model version is the same, only the serving path differs. Empty array is the default and is expected until a host is actually researched or observed via eval_results.served_provider. This is the only provider-pin concept that lives on eval_models: the other two are eval_runs.provider_pin (one run''s requested pin) and eval_results.served_provider (what a specific call actually got), three different grains: known-hosts-for-a-model-version, requested-for-a-run, and served-for-a-call.';
COMMENT ON COLUMN eval_models.attribute_provenance IS 'Per-attribute exceptions to the row-level source column, as {attribute_name: {source, observed_date}}, used only where a specific value is an estimate, third-party figure, or was parsed/inferred rather than read directly from the primary catalog fetch (e.g. a parameter count parsed from a model id''s MoE naming convention rather than a vendor technical report). An attribute with no entry here inherits the row''s source/effective_date as its provenance; this column exists for the exceptions, not as a second copy of every attribute''s provenance.';

COMMENT ON VIEW eval_models_current IS 'Latest known snapshot per slug. eval-run resolves --models against this view when stamping model_version_id.';

COMMENT ON TABLE eval_experiments IS 'One named question under test, identified by a descriptive slug. The falsifiable claim lives in question as prose. Declares its variants and decision rule before running; the runs that answer it are eval_runs rows with experiment_id set. No owner column: exactly one operator runs this program today.';
COMMENT ON COLUMN eval_experiments.slug IS 'Descriptive, public identifier for this experiment (e.g. audit-single-vs-grouped), derived from its question. What eval-run --experiment and any report or doc display.';
COMMENT ON COLUMN eval_experiments.variants_declared IS 'Planned variants, recorded before execution. What actually ran is the set of eval_runs rows with this experiment_id, which may be a subset (a variant was dropped) or differ in settings (a declared plan changed): variants_declared is intent, eval_runs is fact.';
COMMENT ON COLUMN eval_experiments.decision_rule IS 'The rule this experiment is judged by. May carry any of tolerance, precisionTolerance, maxSlideDrop (numeric, each overriding the matching part of the task default from TASK_TOLERANCES in apps/pipeline/src/lib/eval/tolerances.ts) plus description (plain-language prose for a human reading the experiment record). eval-compare resolves this experiment''s runs against the override via tolerances.ts''s resolveTolerance() and states which rule applied in its report; an unrecognized key is ignored and logged as a warning. Empty (the default) means every run on this experiment is judged by the task default with no override.';

COMMENT ON TABLE eval_findings IS 'Append-only record of what was concluded from a run or comparison, with the run and item ids that support it. Never UPDATEd or DELETEd; a change of mind is a new row with supersedes_finding_id pointing at the one it revises, so the earlier claim and what was known when it was made both stay intact.';
COMMENT ON COLUMN eval_findings.run_ids IS 'Not FK-enforced per element (Postgres arrays can''t reference a table), the same "free text, not a foreign key" precedent as eval_sets.source. Move to a join table only if a finding routinely cites more than a handful of runs or a referential-integrity problem actually shows up.';

COMMENT ON TABLE eval_review_rounds IS 'One row per reference-labeling campaign on a set: who labeled it, under what rubric, with what calibration result. Append-only: a re-review under a revised rubric adds a new row rather than overwriting the claim about what confidence applied to labels made under the old one. Distinct from eval_items.reviewed_by/reviewed_at, which are per-item; this is per-campaign.';
COMMENT ON COLUMN eval_review_rounds.set_id IS 'ON DELETE RESTRICT deliberately, unlike eval_items.set_id/eval_runs.set_id which CASCADE from eval_sets: a set with a recorded review round must not disappear silently when the set itself is deleted. Deleting a set that has a recorded review round requires deleting those rows first, as an explicit, separate decision.';
COMMENT ON COLUMN eval_review_rounds.inter_rater IS 'Null is expected and correct with one reviewer (the current condition): there is no second rater to disagree with. This is a named single-instance gap, not a missing feature. When a second reviewer is assigned, this column must actually start getting populated and compared, not stay null by habit.';

COMMENT ON COLUMN eval_runs.experiment_id IS 'The experiment this run belongs to, if any. Nullable: an exploratory or ad hoc run (no registered experiment) is still valid, same as today.';
COMMENT ON COLUMN eval_runs.model_version_id IS 'The eval_models row this run resolved --models against at run time (eval_models_current as of when the run started). Nullable only for backfilled pre-registry runs; every new run going forward should have one.';
COMMENT ON COLUMN eval_runs.provider_pin IS 'The host a run asked for with fallbacks disabled. Together with model_version_id this is a variant''s full identity: "Sonnet 5 on Bedrock" and "Sonnet 5 on Anthropic" are two variants of the same model version. The comparison views group by (model_version_id, provider_pin). What was actually served is eval_results.served_provider, not this column.';

COMMENT ON COLUMN eval_results.served_provider IS 'The host OpenRouter''s response named as having actually served this call (the response''s provider field), alongside the existing served_model. Compared against the owning eval_runs.provider_pin by eval-compare, which flags any run whose results name a provider other than the run''s pin: this turns the pin from an assumption into a verified fact per call.';

COMMENT ON VIEW eval_run_scorecard IS 'One row per run, joined out to its experiment and its model''s dated attributes, with the run''s primary metric pulled out generically. The shape a frontend renders for "compare this model across tasks and time." scored_at and scoring_review_round_id are the run''s own scoring provenance (see their column comments on eval_runs), exposed here so "which runs need a rescore" is a query against this view rather than eval_runs directly. metric_status explains a null primary_metric: ''failed run'' (the run itself did not complete), ''reference reviewed after scoring'' (a metric is present, but a reference changed, by either signal eval_run_metric_status checks, since this run was last scored), ''ok'' (a metric is present and neither of those holds), ''awaiting reviewed references'' (the run''s set has no approved reference item yet), ''scored before references existed'' (the run finished before the set''s earliest approved item was reviewed; re-running eval-rescore fills the metric in), or ''no primary metric'' (none of the above explains it, worth investigating).';
COMMENT ON VIEW eval_model_history IS 'eval_run_scorecard reordered by model slug then start time, for "how has model X trended" across runs of that exact slug.';
COMMENT ON VIEW eval_run_model_stats IS 'One row per run: outcome (primary_metric_value), predictors (model attributes), and covariates (mean_cost_usd, mean_latency_ms, error_count, provider_mismatch_count) in a shape suitable for a regression or grouped-statistics query, e.g. "does parameter_count_total predict primary_metric_value, controlling for task." cost_per_metric_unit is cost per unit of whatever the task''s primary metric measures; it reads literally as "cost per correct answer" only when that task''s primary metric is an accuracy-style fraction (audit, grading); for a continuous score (mapping F1, transcription''s 1-minus-edit-distance) it is cost per point of that score, not a count of correct answers. A dozen or so distinct models with runs today is not enough for a between-model attribute regression (the model, not the item or repeat count, is the unit of replication); treat any single-attribute pattern here as advisory until roughly 15-20 independent models spanning the attribute''s range exist on the same task. metric_status explains a null primary_metric_value the same way it does on eval_run_scorecard.';
COMMENT ON VIEW eval_family_history IS 'eval_run_model_stats reordered by family and snapshot date, for "how has model X trended across versions", the one query eval_model_history cannot answer, since it groups by slug (one version) rather than family_id (a lineage across slug changes). Requires family_id to be populated on eval_models; a model with no family row simply does not appear here (an inner join deliberately, since a LEFT JOIN would produce one all-null row per unlinked model, not useful for a trend query). metric_status explains a null primary_metric_value the same way it does on eval_run_scorecard.';

COMMENT ON VIEW eval_item_consensus IS 'One row per item with at least two completed, non-error runs: how much a task''s variants agree on it, for ranking the human-review queue by disagreement. The verdict compared per result is eval_result_verdict(task, output, deterministic_checks); see that function''s comment for what each task''s case means. Transcription''s content agreement (how similar two runs'' transcripts are on a kept slide) is a similarity question, not a verdict this view can hold, and is answered instead by eval-compare''s per-slide report. Repeat runs of the same variant count once each, so a repeat that flips its own verdict is itself disagreement, not noise to average away. majority_share is the largest single-verdict group''s share of run_count; low values are the items most worth a reviewer''s attention.';
COMMENT ON COLUMN eval_item_consensus.unit_id IS 'From the owning eval_sets row, not eval_items itself, so a reviewer can find the item''s source unit without a second lookup.';
COMMENT ON COLUMN eval_item_consensus.majority_share IS 'The largest single-verdict group''s run count divided by run_count. 1.0 means every run agreed; lower means more disagreement. For a two-verdict task (grading) this equals 1 minus the dashboard snapshot''s disagreement score.';
COMMENT ON COLUMN eval_item_consensus.seeded_class IS 'Copied from eval_items.seeded_class, so the review worklist can be filtered by design class without a join. Null for an item built before the column existed or for a task that does not seed one.';

COMMENT ON VIEW eval_run_behaviour IS 'One row per completed run, computed from eval_results rather than the run''s own summary, so it stays correct for a run whose summary predates a rescore. Ranks a run on what it measurably did with no reference label required, which is the state audit and grading are in until their items are reviewed. task_behaviour is task-specific: audit is each of the six gate criteria''s own flag rate (the share of results where that criterion read false); grading is share_marked_correct; mapping is mean_headings_per_topic and unresolved_count (both over every result, from deterministic_checks); transcription is no_content_marker_rate and mean_coverage. Null for generation/validation, which have no runner. metric_status explains a null primary metric the same way it does on eval_run_scorecard, but this view does not read primary_metric itself.';
COMMENT ON COLUMN eval_run_behaviour.parse_failure_rate IS 'Results with error = ''parse'' divided by result_count, counting every result rather than only ones with output, the same denominator eval-run''s own summary uses.';
COMMENT ON COLUMN eval_run_behaviour.task_behaviour IS 'A JSON object whose keys depend on the run''s task; see the view comment. Null for a task with no behaviour defined here.';

COMMENT ON VIEW eval_variant_stability IS 'One row per distinct variant identity: experiment_id, set_id, model, prompt_hash, and the caller-chosen settings keys (temperature, reasoning, provider, groupSize, shuffleSeed, exclusionPass, renderDpi, mode, grouping), each normalized with the same absent-means-default rule normalizeRepeatIdentitySettings applies in apps/pipeline/src/commands/eval-run.ts: temperature absent means no override was sent (distinct from an explicit value), groupSize/renderDpi absent fall back to their task defaults (1 and 120), mode absent means ''sync'' (the alternative is ''batch''), grouping absent means ''by_order'' (consecutive items in the optionally seeded shuffled order; the alternative is ''by_topic''), the remaining keys absent mean null, and a provider pin''s order array is lowercased. eval-run writes neither mode nor grouping, so every run it makes carries the defaults. This is the SQL twin of that normalizer and must change with it. Grouped over every run whose status is not failed or aborted (matching resolveExistingRepeatCount''s own inclusion rule, not a completed-only filter), so a running run already occupies its identity''s slot even before it has a primary_metric_value to contribute to the spread. Never grouped by variant_label, whose :r2-style suffix carries no meaning the database enforces. run_count, the metric spread (max minus min), and mean cost let a front-end rank repeat stability without re-deriving the grouping in application code; groupSize''s hardcoded default of 1 is the audit task default today (AUDIT_GROUP_SIZE) but does not branch by task the way the TypeScript does, so it silently stops matching if that constant ever changes.';
COMMENT ON COLUMN eval_variant_stability.primary_metric_spread IS 'max(primary_metric_value) minus min(primary_metric_value) across the group''s runs; null when fewer than two runs have a non-null primary metric.';

COMMENT ON VIEW eval_experiment_variants IS 'One row per entry of eval_experiments.variants_declared, with the count and ids of the eval_runs rows that match it. Candidate runs are those attributed to the declaring experiment or, when the declaration carries baseline_from (the slug of another experiment, valid on a baseline), those attributed to the experiment it names: a decision may be made against a baseline run that belongs to another experiment, and runs_from_slug names that experiment (null when the runs are the declaring experiment''s own; a slug that matches no experiment leaves the variant with no runs). A run matches when its model equals the declared model_slug and, for every key the declared settings object carries, the run''s own settings normalize (the same absent-means-default rule eval_variant_stability applies, including mode absent meaning ''sync'' and grouping absent meaning ''by_order'') to that declared value; a declared key absent from the run''s settings is an unconstrained match, not a mismatch. exclusionPass is the one key normalized differently from eval_variant_stability: it matches on the classifier model slug alone, ignoring the classifier''s provider and prompt hash, since a declaration names the classifier by slug (a bare string) while a run stores the full object it called ({model, provider, promptHash}): both sides reduce to their model key before comparing, and null (no exclusion pass declared or run) stays null. failed and aborted runs never match. Never joins on declared_label: a run''s own variant_label is chosen freely at eval-run time and is not reliably the same string as the plan''s label. ambiguous is true when this declared variant and another one on the same experiment match at least one run in common (typically two variants that share a model_slug and whose settings never conflict), so an overlapping run is reported under every variant it matches rather than one being picked silently. A declaration with no model_slug or ''*'' matches nothing by design: its ambiguous is null and its run_count 0, even when runs exist for the models it was meant to cover (a baseline declared across several models, or with a wildcard model, is in this case). declaredVariantMatchesRun in apps/pipeline/src/commands/eval-run.ts is the TypeScript twin of this match rule and must change with it.';

COMMENT ON VIEW eval_experiment_dependencies IS 'One row per entry of eval_experiments.depends_on, with that dependency''s current status, or ''missing'' when no experiment carries that slug (a typo, or a dependency not yet created).';

ALTER TABLE eval_results
  ADD COLUMN response_meta JSONB;

COMMENT ON COLUMN eval_results.response_meta IS 'OpenRouter response facts with no column of their own: the response id, created, each choice''s finish_reason and native_finish_reason, and the parts of usage that parseUsage does not already map (cached token counts, the upstream-cost breakdown). Never contains message content. Kept when a call returned content, including content that then failed to parse (error parse); null when the call failed or returned no content (error api or empty). One shape per task: the primary call''s fields at the top level; a transcription row whose slide went through --exclusion-pass adds a classifier key holding the same fields for the classifier call plus its served_model and served_provider, which this row''s own served_model/served_provider columns do not carry (they describe the transcription call only). A transcription row is therefore one of four shapes: null (no call returned a response); top-level fields only (no exclusion pass ran); top-level plus classifier (both calls returned a response); or classifier only, meaning the transcription call returned nothing to record, told apart by the row''s error and deterministic_checks.exclusion_decision: the classifier dropped the slide (no error, decision drop, no transcription call made), the transcription call failed after the classifier kept the slide (error api or empty, decision keep), or the classifier''s own response did not parse (error parse, decision null). For a grouped audit call (several questions in one call) this is the whole call''s response, written identically on every row in the group: unlike the per-row token columns, which are that group''s split, this value is not divisible and must not be summed across rows. Nothing reads this column yet; it exists so a question asked later about one specific call, such as which host served it or why it stopped, can be answered from the row.';

-- ============================================================
-- Evaluation read-only summary views
-- Aggregates a reader can take as computed so no application does arithmetic over stored counts.
-- No tracked code reads these four views yet. None selects question text, model output, reviewer
-- material, judge reasons or free-text error fields.
-- ============================================================

CREATE OR REPLACE VIEW eval_reference_status_by_task WITH (security_invoker = true) AS
SELECT
  es.task,
  ei.reference_status,
  count(*)                 AS item_count,
  count(DISTINCT es.id)    AS set_count
FROM eval_items ei
JOIN eval_sets es ON es.id = ei.set_id
GROUP BY es.task, ei.reference_status;

COMMENT ON VIEW eval_reference_status_by_task IS 'One row per task and reference_status that has at least one item: how many items carry that status and in how many sets. A task with no approved row has no reviewed references, so its runs carry agreement and behaviour figures rather than accuracy.';

CREATE OR REPLACE VIEW eval_provider_coverage WITH (security_invoker = true) AS
WITH run_mismatch AS (
  SELECT task, COALESCE(sum(provider_mismatch_count), 0)::bigint AS provider_mismatch_count
  FROM eval_run_model_stats
  GROUP BY task
),
per_task AS (
  SELECT
    r.task,
    count(*)                                                                 AS result_count,
    count(*) FILTER (WHERE res.error IS NOT NULL)                            AS errored_result_count,
    count(*) FILTER (WHERE res.error IS NULL AND res.served_provider IS NULL
                     AND (res.deterministic_checks ->> 'exclusion_decision') IS DISTINCT FROM 'drop') AS served_provider_null_count,
    count(*) FILTER (WHERE res.error IS NULL
                     AND (res.deterministic_checks ->> 'exclusion_decision') IS DISTINCT FROM 'drop') AS non_errored_result_count,
    count(DISTINCT r.id) FILTER (WHERE r.provider_pin IS NOT NULL)           AS pinned_run_count,
    count(DISTINCT r.provider_pin)                                           AS distinct_pin_values_exact,
    count(DISTINCT lower(r.provider_pin))                                    AS distinct_pin_values_lowercased,
    count(*) FILTER (WHERE (res.deterministic_checks ->> 'exclusion_decision') = 'drop') AS dropped_result_count
  FROM eval_results res
  JOIN eval_runs r ON r.id = res.run_id
  GROUP BY r.task
)
SELECT
  p.task,
  p.result_count,
  p.errored_result_count,
  p.served_provider_null_count,
  round(p.served_provider_null_count::numeric / nullif(p.non_errored_result_count, 0), 4) AS served_provider_null_share,
  p.pinned_run_count,
  p.distinct_pin_values_exact,
  p.distinct_pin_values_lowercased,
  COALESCE(m.provider_mismatch_count, 0)                                                  AS provider_mismatch_count,
  p.dropped_result_count
FROM per_task p
LEFT JOIN run_mismatch m ON m.task = p.task;

COMMENT ON VIEW eval_provider_coverage IS 'One row per task that has results: how many results never recorded a serving host, how runs pinned a host, and how many results came from a different host than the pin. An errored result never reports a host, so served_provider_null_count and served_provider_null_share are taken over results with no error; errored_result_count is the number left out, and result_count is the total. distinct_pin_values_lowercased is a spelling count only (lower(provider_pin)); it is not the comparison eval_normalize_provider applies, which also strips every non-alphanumeric character and drops the host suffix after a slash. provider_mismatch_count sums eval_run_model_stats.provider_mismatch_count, which counts only results that recorded a serving host. Pin values themselves are not returned. A transcription slide the exclusion pass dropped makes no transcription call, so it has no serving host by design; those results (counted in dropped_result_count and still part of result_count) are left out of served_provider_null_count and served_provider_null_share so a dropped slide is not read as a result that failed to record a host. pinned_run_count and the pin-spelling counts cover runs with at least one result.';

CREATE OR REPLACE VIEW eval_metric_status_by_task WITH (security_invoker = true) AS
SELECT
  task,
  metric_status,
  count(*) AS run_count
FROM eval_run_scorecard
GROUP BY task, metric_status;

COMMENT ON VIEW eval_metric_status_by_task IS 'One row per task and metric_status (see eval_run_scorecard) that has at least one run, with the number of runs in it. Shows how many runs on each task carry a final accuracy figure and how many are waiting on reviewed references or a rescore.';

CREATE OR REPLACE VIEW eval_run_snapshot_status WITH (security_invoker = true) AS
SELECT
  r.id                     AS run_id,
  r.task,
  x.slug                   AS experiment_slug,
  r.variant_label,
  r.model                  AS model_slug,
  m.effective_date         AS run_effective_date,
  c.effective_date         AS current_effective_date,
  CASE
    WHEN r.model_version_id IS NULL THEN 'unregistered'
    WHEN c.id = m.id THEN 'current'
    WHEN c.id <> m.id THEN 'superseded'
  END                      AS snapshot_state
FROM eval_runs r
LEFT JOIN eval_experiments x ON x.id = r.experiment_id
LEFT JOIN eval_models m ON m.id = r.model_version_id
LEFT JOIN eval_models_current c ON c.slug = m.slug;

COMMENT ON VIEW eval_run_snapshot_status IS 'One row per run: whether the model snapshot the run resolved at start is still the latest for its slug. current means it is; superseded means a newer snapshot of the slug has been registered since, so the model attributes and price the run was stamped with have been replaced; unregistered means the run has no snapshot (model_version_id is null). A null state is unreachable while every run''s snapshot slug has a current row in eval_models_current. run_effective_date and current_effective_date are the two snapshot dates being compared.';
