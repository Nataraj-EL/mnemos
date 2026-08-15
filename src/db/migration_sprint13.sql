-- Add additive migration for conversations table
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER,
    transcript TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index user queries on conversations
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations (user_id);
