-- Add additive migration for conversations embedding support (Sprint 21)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS embedding vector(768);
