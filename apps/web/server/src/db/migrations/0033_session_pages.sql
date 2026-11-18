-- Bounded owner-scoped active-session traversal; no additional grants.
CREATE INDEX sessions_active_page ON sessions(deployment_id,user_id,auth_version,created_at,id) WHERE revoked_at IS NULL;
