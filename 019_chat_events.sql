-- Chat events table for funnel analysis and A/B testing
CREATE TABLE IF NOT EXISTS chat_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,        -- 'open' | 'navigate' | 'input_start' | 'phone_tap' | 'ai_switch' | 'submit' | 'close'
  node TEXT,                  -- current scenario node ID
  variant TEXT DEFAULT 'a',   -- A/B test variant
  metadata JSONB,             -- extensible (e.g. ui_type, input_method)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_events_session ON chat_events(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_events_variant_event ON chat_events(variant, event);
CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at);

-- Allow anonymous inserts (widget sends events without auth)
ALTER TABLE chat_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_events_insert_anon" ON chat_events
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "chat_events_select_auth" ON chat_events
  FOR SELECT TO authenticated USING (true);

-- Add variant column to chat_sessions
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS variant TEXT DEFAULT 'a';
