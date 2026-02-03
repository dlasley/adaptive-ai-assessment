-- Add superuser column to study_codes table
-- Superusers get additional evaluation metadata for debugging/analysis

ALTER TABLE study_codes
ADD COLUMN is_superuser BOOLEAN DEFAULT false NOT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN study_codes.is_superuser IS
  'When true, user receives detailed evaluation metadata including confidence scores, similarity metrics, and which evaluation tier was used';

-- Create index for efficient querying of superusers
CREATE INDEX idx_study_codes_superuser ON study_codes(is_superuser) WHERE is_superuser = true;
