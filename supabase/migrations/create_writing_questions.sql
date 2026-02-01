-- French Writing Questions System
-- Stores open-ended writing questions with AI evaluation

-- Writing Questions Table
CREATE TABLE writing_questions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_en TEXT NOT NULL,              -- English prompt/question
  correct_answer_fr TEXT,                 -- Main correct answer (for reference)
  acceptable_variations JSONB DEFAULT '[]', -- Array of acceptable answer variations
  topic TEXT NOT NULL,                     -- e.g., 'greetings', 'verb_conjugation', 'daily_routine'
  difficulty TEXT NOT NULL,                -- 'beginner', 'intermediate', 'advanced'
  question_type TEXT NOT NULL,             -- 'translation', 'conjugation', 'open_ended', 'question_formation'
  explanation TEXT,                        -- Explanation of the correct answer
  hints JSONB DEFAULT '[]',                -- Array of hints to help students
  unit_id TEXT,                           -- Link to curriculum unit
  requires_complete_sentence BOOLEAN DEFAULT false, -- True for advanced questions
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Writing Question Attempts Table
CREATE TABLE writing_question_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  study_code_id UUID REFERENCES study_codes(id) ON DELETE CASCADE,
  question_id UUID REFERENCES writing_questions(id) ON DELETE CASCADE,
  user_answer TEXT NOT NULL,

  -- Evaluation results
  is_correct BOOLEAN NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  has_correct_accents BOOLEAN,           -- Did they use accents correctly?
  feedback TEXT,                         -- AI-generated feedback
  corrections JSONB DEFAULT '{}',        -- Structured corrections

  -- Metadata
  attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  evaluation_model TEXT DEFAULT 'claude-opus-4-5-20251101'
);

-- Indexes
CREATE INDEX idx_writing_questions_difficulty ON writing_questions(difficulty);
CREATE INDEX idx_writing_questions_topic ON writing_questions(topic);
CREATE INDEX idx_writing_questions_unit ON writing_questions(unit_id);
CREATE INDEX idx_writing_attempts_study_code ON writing_question_attempts(study_code_id);
CREATE INDEX idx_writing_attempts_question ON writing_question_attempts(question_id);
CREATE INDEX idx_writing_attempts_date ON writing_question_attempts(attempted_at DESC);

-- Row Level Security
ALTER TABLE writing_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE writing_question_attempts ENABLE ROW LEVEL SECURITY;

-- Everyone can read questions (they're educational content)
CREATE POLICY "Anyone can read writing questions"
  ON writing_questions FOR SELECT
  USING (true);

-- Anyone can insert their own attempts
CREATE POLICY "Anyone can insert writing attempts"
  ON writing_question_attempts FOR INSERT
  WITH CHECK (true);

-- Users can read their own attempts
CREATE POLICY "Users can read their own writing attempts"
  ON writing_question_attempts FOR SELECT
  USING (true);

-- Comments
COMMENT ON TABLE writing_questions IS 'French writing questions requiring typed answers';
COMMENT ON TABLE writing_question_attempts IS 'Student attempts at writing questions with AI evaluation';
COMMENT ON COLUMN writing_questions.requires_complete_sentence IS 'Advanced questions requiring full sentence responses';
COMMENT ON COLUMN writing_question_attempts.has_correct_accents IS 'Whether student used diacritic accents correctly';
COMMENT ON COLUMN writing_question_attempts.score IS 'Score from 0-100, allowing partial credit';
