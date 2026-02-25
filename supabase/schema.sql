-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Study Codes Table
-- Stores anonymous student identifiers and basic info
CREATE TABLE study_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT UNIQUE NOT NULL,
  display_name TEXT, -- Optional: student can add their name
  admin_label TEXT, -- Optional label/identifier assigned by admin, not visible to students
  is_superuser BOOLEAN DEFAULT false NOT NULL, -- Enables detailed evaluation metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  total_quizzes INTEGER DEFAULT 0,
  total_questions INTEGER DEFAULT 0,
  correct_answers INTEGER DEFAULT 0,
  wrong_answer_countdown INTEGER DEFAULT NULL -- Per-user override for wrong answer countdown (NULL = global default)
  -- No code_format constraint: validation happens in application layer
  -- Supports both old "study-xxxxxxxx" and new "adjective animal" formats
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
  prompt_hash TEXT                             -- SHA-256 prefix of prompt template for change detection
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
  requires_complete_sentence BOOLEAN DEFAULT FALSE,

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

CREATE INDEX idx_lr_unit ON learning_resources(unit_id);
CREATE INDEX idx_lr_unit_topic ON learning_resources(unit_id, topic);
CREATE INDEX idx_lr_topic ON learning_resources(topic);
CREATE INDEX idx_lr_content_hash ON learning_resources(content_hash);
CREATE INDEX idx_lr_quality ON learning_resources(quality_status);

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

-- Function to generate unique study code
CREATE OR REPLACE FUNCTION generate_study_code()
RETURNS TEXT AS $$
DECLARE
  new_code TEXT;
  code_exists BOOLEAN;
BEGIN
  LOOP
    -- Generate format: study-xxxxxxxx (8 random alphanumeric chars)
    new_code := 'study-' || lower(substring(md5(random()::text) from 1 for 8));

    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM study_codes WHERE code = new_code) INTO code_exists;

    -- If unique, return it
    IF NOT code_exists THEN
      RETURN new_code;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

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

-- Function to calculate overall stats
CREATE OR REPLACE FUNCTION calculate_overall_stats(code_id UUID)
RETURNS TABLE(
  total_quizzes BIGINT,
  total_questions BIGINT,
  correct_answers BIGINT,
  overall_accuracy NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(DISTINCT qh.id)::BIGINT as total_quizzes,
    COUNT(qr.id)::BIGINT as total_questions,
    SUM(CASE WHEN qr.is_correct THEN 1 ELSE 0 END)::BIGINT as correct_answers,
    ROUND(
      (SUM(CASE WHEN qr.is_correct THEN 1 ELSE 0 END)::NUMERIC /
       COUNT(qr.id)::NUMERIC) * 100,
      2
    ) as overall_accuracy
  FROM quiz_history qh
  LEFT JOIN question_results qr ON qr.quiz_history_id = qh.id
  WHERE qh.study_code_id = code_id;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

-- Function to update questions.updated_at timestamp
CREATE OR REPLACE FUNCTION update_questions_updated_at()
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
  EXECUTE FUNCTION update_questions_updated_at();

-- Auto-update updated_at on units (reuses existing trigger function)
CREATE TRIGGER units_updated_at
  BEFORE UPDATE ON units
  FOR EACH ROW
  EXECUTE FUNCTION update_questions_updated_at();

-- Auto-update updated_at on learning_resources (reuses existing trigger function)
CREATE TRIGGER learning_resources_updated_at
  BEFORE UPDATE ON learning_resources
  FOR EACH ROW
  EXECUTE FUNCTION update_questions_updated_at();

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

-- Study codes policies (no DELETE for anon; INSERT/UPDATE restricted)
CREATE POLICY "anon_select_study_codes"
  ON study_codes FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_study_codes"
  ON study_codes FOR INSERT
  TO anon
  WITH CHECK (
    is_superuser = false
    AND admin_label IS NULL
    AND wrong_answer_countdown IS NULL
  );

CREATE POLICY "anon_update_study_codes"
  ON study_codes FOR UPDATE
  TO anon
  USING (true);

-- Quiz history policies (SELECT + INSERT only)
CREATE POLICY "anon_select_quiz_history"
  ON quiz_history FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_quiz_history"
  ON quiz_history FOR INSERT
  TO anon
  WITH CHECK (true);

-- Question results policies (SELECT + INSERT only)
CREATE POLICY "anon_select_question_results"
  ON question_results FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_question_results"
  ON question_results FOR INSERT
  TO anon
  WITH CHECK (true);

-- Questions policies (read-only for anon; scripts use secret key for writes)
CREATE POLICY "anon_select_questions"
  ON questions FOR SELECT
  TO anon
  USING (true);

-- Batches policies (read-only for anon; scripts use secret key for writes)
CREATE POLICY "anon_select_batches"
  ON batches FOR SELECT
  TO anon
  USING (true);

-- Leitner state policies (SELECT + INSERT + UPDATE; DELETE cascades from study_codes)
CREATE POLICY "anon_select_leitner_state"
  ON leitner_state FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_insert_leitner_state"
  ON leitner_state FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon_update_leitner_state"
  ON leitner_state FOR UPDATE
  TO anon
  USING (true);

-- Units policies (read-only for anon; scripts use secret key for writes)
CREATE POLICY "anon_select_units"
  ON units FOR SELECT
  TO anon
  USING (true);

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
COMMENT ON COLUMN questions.requires_complete_sentence IS 'Advanced questions requiring full sentence responses';
COMMENT ON COLUMN questions.content_hash IS 'MD5 hash of normalized question content for deduplication during regeneration';
COMMENT ON COLUMN questions.batch_id IS 'Identifies which generation batch created this question (e.g., 2026-02-04_unit3)';
COMMENT ON COLUMN questions.source_file IS 'Path to the markdown learning file used to generate this question';
COMMENT ON COLUMN questions.generated_by IS 'Model ID that generated this question (e.g., claude-haiku-4-5-20251001). Per-question for multi-model support.';
COMMENT ON COLUMN questions.quality_status IS 'Audit status: pending (awaiting audit, not served), active (serves to students), or flagged (excluded from quizzes)';
COMMENT ON COLUMN questions.audit_metadata IS 'Stage 3 audit & remediation diagnostic snapshot: criteria results, suggested_difficulty, missing/invalid variations. Written by audit scripts alongside quality_status. Mistral applies difficulty relabeling + invalid variation removal.';
COMMENT ON TABLE batches IS 'Metadata for each question generation batch run. Tracks pipeline state, model, config, and results.';
COMMENT ON COLUMN question_results.score IS 'Evaluation score 0-100. NULL for legacy data. MCQ/TF are always 0 or 100. Typed answers use fuzzy/API evaluation score.';
COMMENT ON TABLE leitner_state IS 'Leitner spaced repetition box assignments per student per question';
COMMENT ON COLUMN leitner_state.box IS 'Leitner box 1-5. Box 1 = most frequent review, Box 5 = mastered';
COMMENT ON COLUMN leitner_state.consecutive_correct IS 'Number of consecutive correct answers. Resets to 0 on wrong answer.';
COMMENT ON COLUMN leitner_state.last_reviewed IS 'When this question was last attempted';
COMMENT ON TABLE learning_resources IS 'Learning resources (videos, articles, etc.) organized by unit and topic. Resource-type-agnostic for future extensibility.';
COMMENT ON TABLE study_code_source_words IS 'Adjective/animal word pools for server-side study code generation. No anon RLS — only service role can access.';
COMMENT ON COLUMN study_code_source_words.first_letter IS 'Generated column for efficient alliterative pair lookups';
COMMENT ON COLUMN learning_resources.provider IS 'Content host identifier: youtube, vimeo, etc.';
COMMENT ON COLUMN learning_resources.metadata IS 'Extensible JSON: videoId, isShort, channelName, language, etc.';
COMMENT ON COLUMN learning_resources.content_hash IS 'MD5(url|unit_id|topic) for deduplication during extraction';
COMMENT ON VIEW weak_topics IS 'Topics where student needs help (< 70% accuracy, >= 1 attempt)';

-- ============================================================
-- Experiment Framework Tables
-- Twin-store pattern: experiment_questions mirrors questions,
-- experiment_batches mirrors batches. Fully segregated from production data.
-- ============================================================

-- Experiments: top-level experiment record
CREATE TABLE experiments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  unit_id TEXT NOT NULL,

  -- Experiment design (captured interactively at creation)
  name TEXT NOT NULL,
  research_question TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  independent_variable TEXT NOT NULL,
  primary_metric TEXT NOT NULL DEFAULT 'gate_pass_rate',
  description TEXT,

  -- Provenance (auto-captured)
  git_branch TEXT,
  git_commit TEXT,
  pipeline_config JSONB,

  -- Cohort data (built incrementally)
  cohorts JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Results (populated after comparison)
  results JSONB,
  conclusion TEXT,
  report_path TEXT
);

-- Experiment Batches: mirrors batches + experiment linkage
CREATE TABLE experiment_batches (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  model TEXT,
  unit_id TEXT,
  difficulty TEXT,
  type_filter TEXT,
  question_count INTEGER DEFAULT 0,
  inserted_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  config JSONB DEFAULT '{}'::jsonb,
  quality_metrics JSONB,
  description TEXT,
  prompt_hash TEXT,

  -- Experiment linkage
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  cohort TEXT NOT NULL
);

CREATE INDEX idx_experiment_batches_experiment ON experiment_batches(experiment_id);
CREATE INDEX idx_experiment_batches_experiment_cohort ON experiment_batches(experiment_id, cohort);

-- Experiment Questions: mirrors questions + experiment linkage
-- No prevent_flagged_deletion trigger (experiment data is historical)
CREATE TABLE experiment_questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Experiment linkage
  experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  cohort TEXT NOT NULL,
  original_question_id UUID,

  -- Core fields (mirrors questions table)
  question TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  explanation TEXT,
  unit_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  type TEXT NOT NULL CHECK (type IN ('multiple-choice', 'true-false', 'fill-in-blank', 'writing')),

  -- Type-specific fields
  options TEXT[],
  acceptable_variations TEXT[] DEFAULT '{}',
  writing_type TEXT CHECK (writing_type IS NULL OR writing_type IN ('translation', 'conjugation', 'open_ended', 'question_formation', 'sentence_building')),
  hints TEXT[] DEFAULT '{}',
  requires_complete_sentence BOOLEAN DEFAULT FALSE,

  -- Metadata
  content_hash TEXT,
  batch_id TEXT REFERENCES experiment_batches(id) ON DELETE CASCADE,
  source_file TEXT,
  generated_by TEXT,
  quality_status TEXT DEFAULT 'pending' CHECK (quality_status IN ('active', 'flagged', 'pending')),
  audit_metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_experiment_questions_experiment ON experiment_questions(experiment_id);
CREATE INDEX idx_experiment_questions_experiment_cohort ON experiment_questions(experiment_id, cohort);
CREATE INDEX idx_experiment_questions_content_hash ON experiment_questions(content_hash);

CREATE TRIGGER experiment_questions_updated_at
  BEFORE UPDATE ON experiment_questions
  FOR EACH ROW
  EXECUTE FUNCTION update_questions_updated_at();

-- RLS for experiment tables
ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE experiment_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_select_experiments"
  ON experiments FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_select_experiment_questions"
  ON experiment_questions FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "anon_select_experiment_batches"
  ON experiment_batches FOR SELECT
  TO anon
  USING (true);

-- Experiment table comments
COMMENT ON TABLE experiments IS 'Top-level experiment records with design metadata, provenance, cohort data, and results';
COMMENT ON COLUMN experiments.research_question IS 'What are we trying to learn? Specific, answerable question.';
COMMENT ON COLUMN experiments.hypothesis IS 'Falsifiable prediction with expected direction and magnitude';
COMMENT ON COLUMN experiments.independent_variable IS 'What single factor changes between treatment cohorts';
COMMENT ON COLUMN experiments.primary_metric IS 'Main success metric: gate_pass_rate, difficulty_mismatch_rate, per_criterion_failure, or custom';
COMMENT ON COLUMN experiments.pipeline_config IS 'Experiment-level defaults from config.ts MODELS at creation time';
COMMENT ON COLUMN experiments.cohorts IS 'Array of cohort metadata objects (label, source_type, question_count, batch_ids, stage2_metrics)';
COMMENT ON COLUMN experiments.results IS 'Full comparison metrics from compare-experiments.ts';
COMMENT ON COLUMN experiments.conclusion IS 'Auto-generated summary of whether hypothesis was supported/refuted';
COMMENT ON COLUMN experiments.report_path IS 'Path to generated markdown comparison report';

COMMENT ON TABLE experiment_questions IS 'Mirrors questions table with experiment linkage. No flagged-deletion protection (experiment data is historical).';
COMMENT ON COLUMN experiment_questions.experiment_id IS 'Parent experiment';
COMMENT ON COLUMN experiment_questions.cohort IS 'Cohort label: control, B, C, etc.';
COMMENT ON COLUMN experiment_questions.original_question_id IS 'For control cohort: original question ID from production. Informational only, no FK.';

COMMENT ON TABLE experiment_batches IS 'Mirrors batches table with experiment linkage. config JSONB contains comprehensive provenance (git, models, cli_args).';
COMMENT ON COLUMN experiment_batches.experiment_id IS 'Parent experiment';
COMMENT ON COLUMN experiment_batches.cohort IS 'Cohort label: control, B, C, etc.';
COMMENT ON COLUMN experiment_batches.config IS 'Comprehensive provenance: { git: { branch, commit }, models: { ... }, cli_args: { ... } }';
