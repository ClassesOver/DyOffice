-- Additive owner-bound browser-session audit. Earlier migration bytes stay immutable.
-- This branch's legacy identity migration line is NOT the src/db line in PR #21.
ALTER TABLE dyoffice_sessions
  ADD CONSTRAINT dyoffice_sessions_owner_identity UNIQUE (deployment_id, user_id, id);

CREATE TABLE dyoffice_session_security_events (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  user_id UUID NOT NULL,
  actor_session_id UUID NOT NULL,
  target_session_id UUID,
  action VARCHAR(32) NOT NULL,
  affected_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT dyoffice_session_event_shape CHECK (
    (action = 'session.revoked' AND target_session_id IS NOT NULL AND affected_count = 1)
    OR (action = 'session.others_revoked' AND target_session_id IS NULL AND affected_count > 0)
  ),
  FOREIGN KEY (deployment_id, user_id) REFERENCES dyoffice_users (deployment_id, id),
  FOREIGN KEY (deployment_id, user_id, actor_session_id)
    REFERENCES dyoffice_sessions (deployment_id, user_id, id),
  FOREIGN KEY (deployment_id, user_id, target_session_id)
    REFERENCES dyoffice_sessions (deployment_id, user_id, id)
);
CREATE INDEX dyoffice_session_events_owner_time_idx
  ON dyoffice_session_security_events (deployment_id, user_id, created_at, id);
-- No cascading deletion: retention/archival must handle audit references explicitly.
-- Runtime grants, append-only privilege policy and FORCE RLS still require T04.
