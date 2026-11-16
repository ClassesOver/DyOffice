CREATE TABLE deployments (
  id uuid PRIMARY KEY,
  bootstrap_completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  username_normalized text NOT NULL CHECK (username_normalized ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name text NOT NULL DEFAULT '' CHECK (length(display_name) <= 200),
  status text NOT NULL CHECK (status IN ('pending','active','disabled')),
  password_hash text,
  password_changed_at timestamptz,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  UNIQUE (deployment_id, username_normalized),
  UNIQUE (deployment_id, id),
  CHECK (status <> 'active' OR password_hash IS NOT NULL)
);
CREATE TABLE user_roles (
  deployment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('personal','config_admin','operator','auditor')),
  PRIMARY KEY (deployment_id,user_id,role),
  FOREIGN KEY (deployment_id,user_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id,owner_id),
  UNIQUE (deployment_id,owner_id,id),
  FOREIGN KEY (deployment_id,owner_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  auth_version integer NOT NULL CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  reauthenticated_at timestamptz,
  CHECK (expires_at > created_at),
  FOREIGN KEY (deployment_id,user_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);
CREATE TABLE password_action_tokens (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('activate','reset')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid NOT NULL,
  CHECK (expires_at > created_at),
  FOREIGN KEY (deployment_id,user_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE,
  FOREIGN KEY (deployment_id,issued_by) REFERENCES users(deployment_id,id)
);
CREATE TABLE auth_audit_events (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('admin_bootstrapped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (deployment_id,actor_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);
-- Auth lookup roles and business RLS are installed separately by T04. This
-- schema/migration connection is not evidence of a restricted runtime identity.
REVOKE ALL ON deployments, users, user_roles, workspaces, sessions, password_action_tokens, auth_audit_events FROM PUBLIC;
