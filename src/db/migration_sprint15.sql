-- Sprint 15: Safe additive migration to add a summary field to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT;
