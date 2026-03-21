-- Chatbot tables for jikonavi chat widget
-- Stores chat sessions and messages for analytics and future CRM integration

-- Sessions table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL UNIQUE,
  user_name TEXT,
  user_agent TEXT,
  referrer TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  used_ai BOOLEAN DEFAULT false,
  -- Phase 3: CRM integration
  patient_id TEXT,
  converted BOOLEAN DEFAULT false
);

-- Messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',  -- text | scenario_select | ai_question | ai_response
  scenario_node TEXT,
  tokens_used INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_started ON chat_sessions(started_at DESC);

-- RLS
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Authenticated users (CRM admins) can read
CREATE POLICY "Authenticated users can read chat_sessions"
  ON chat_sessions FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can read chat_messages"
  ON chat_messages FOR SELECT
  USING (auth.role() = 'authenticated');

-- Helper function for incrementing message count
CREATE OR REPLACE FUNCTION increment_chat_message_count(p_session_id TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE chat_sessions
  SET message_count = message_count + 1
  WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
