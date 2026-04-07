-- Add experiment metadata columns for A/B test management
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS experiment_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS scenario_version TEXT;

ALTER TABLE chat_events ADD COLUMN IF NOT EXISTS experiment_id TEXT;
ALTER TABLE chat_events ADD COLUMN IF NOT EXISTS scenario_version TEXT;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_experiment_variant
  ON chat_sessions(experiment_id, variant);

CREATE INDEX IF NOT EXISTS idx_chat_events_experiment_variant
  ON chat_events(experiment_id, variant);
