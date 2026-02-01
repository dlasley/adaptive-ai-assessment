-- Create writing_questions table
CREATE TABLE IF NOT EXISTS public.writing_questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question_en TEXT NOT NULL,
  correct_answer_fr TEXT,
  acceptable_variations TEXT[] DEFAULT '{}',
  topic TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced')),
  question_type TEXT NOT NULL CHECK (question_type IN ('translation', 'conjugation', 'open_ended', 'question_formation', 'sentence_building')),
  explanation TEXT,
  hints TEXT[] DEFAULT '{}',
  requires_complete_sentence BOOLEAN DEFAULT FALSE,
  unit_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on difficulty for faster queries
CREATE INDEX IF NOT EXISTS idx_writing_questions_difficulty ON public.writing_questions(difficulty);

-- Create index on topic for faster queries
CREATE INDEX IF NOT EXISTS idx_writing_questions_topic ON public.writing_questions(topic);

-- Create index on question_type for faster queries
CREATE INDEX IF NOT EXISTS idx_writing_questions_type ON public.writing_questions(question_type);

-- Enable Row Level Security
ALTER TABLE public.writing_questions ENABLE ROW LEVEL SECURITY;

-- Create policy to allow public read access
CREATE POLICY "Allow public read access" ON public.writing_questions
  FOR SELECT
  USING (true);

-- Create policy to allow authenticated insert (for scripts)
CREATE POLICY "Allow authenticated insert" ON public.writing_questions
  FOR INSERT
  WITH CHECK (true);

-- Create policy to allow authenticated update
CREATE POLICY "Allow authenticated update" ON public.writing_questions
  FOR UPDATE
  USING (true)
  WITH CHECK (true);

-- Create policy to allow authenticated delete
CREATE POLICY "Allow authenticated delete" ON public.writing_questions
  FOR DELETE
  USING (true);
