-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the base memories table if it does not exist yet (Sprint 1 & 2 base)
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Safely add the embedding column to the memories table without destroying existing records
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Add an index on user_id for fast queries
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories (user_id);
