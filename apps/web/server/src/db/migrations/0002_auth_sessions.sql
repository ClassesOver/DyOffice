CREATE TABLE login_challenges (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX login_challenges_expiry ON login_challenges(expires_at);
CREATE TABLE login_throttles (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('account','ip','global')),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  strikes integer NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  blocked_until timestamptz,
  PRIMARY KEY (deployment_id,kind,key_hash)
);
CREATE INDEX login_throttles_expiry ON login_throttles(deployment_id,window_started_at);
CREATE TABLE auth_security_events (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  actor_id uuid,
  request_id uuid NOT NULL,
  session_id uuid,
  account_key text CHECK (account_key IS NULL OR account_key ~ '^[0-9a-f]{64}$'),
  event text NOT NULL CHECK (event IN ('login_failed','login_succeeded','login_throttled','logout','session_revoked','reauthenticated')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (deployment_id,actor_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);
CREATE INDEX sessions_owner_lookup ON sessions(deployment_id,user_id,id);
REVOKE ALL ON login_challenges,login_throttles,auth_security_events FROM PUBLIC;
