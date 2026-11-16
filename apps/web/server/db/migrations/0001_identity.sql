-- DyOffice T03a: local identity data model. Application paths must not be enabled
-- until T03b authentication, T04 ownership/RLS, and production tests are complete.
-- Execute once in a controlled migration transaction, with dedicated migration role.
-- UUIDs and bootstrap credentials are supplied by the trusted server/CLI, never SQL defaults.

CREATE TABLE dyoffice_users (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  username_normalized VARCHAR(64) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  password_hash TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  auth_version BIGINT NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  password_changed_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dyoffice_username_format CHECK (username_normalized ~ '^[a-z][a-z0-9._-]{2,63}$'),
  CONSTRAINT dyoffice_password_format CHECK (password_hash IS NULL OR password_hash LIKE '$argon2id$%'),
  CONSTRAINT dyoffice_active_has_password CHECK (status <> 'active' OR password_hash IS NOT NULL),
  CONSTRAINT dyoffice_user_deployment_unique UNIQUE (deployment_id, id),
  CONSTRAINT dyoffice_username_unique UNIQUE (deployment_id, username_normalized)
);

CREATE TABLE dyoffice_user_roles (
  deployment_id UUID NOT NULL,
  user_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'config_admin', 'operator', 'auditor')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, user_id, role),
  FOREIGN KEY (deployment_id, user_id) REFERENCES dyoffice_users (deployment_id, id)
);

CREATE TABLE dyoffice_personal_workspaces (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT dyoffice_one_workspace_per_owner UNIQUE (deployment_id, owner_user_id),
  CONSTRAINT dyoffice_workspace_owner_fk FOREIGN KEY (deployment_id, owner_user_id)
    REFERENCES dyoffice_users (deployment_id, id)
);

CREATE TABLE dyoffice_sessions (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  user_id UUID NOT NULL,
  -- SHA-256 of a high-entropy random session token, NOT a human password.
  session_token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(session_token_hash) = 32),
  auth_version BIGINT NOT NULL CHECK (auth_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (deployment_id, user_id) REFERENCES dyoffice_users (deployment_id, id),
  CONSTRAINT dyoffice_session_expiry CHECK (expires_at > created_at)
);
CREATE INDEX dyoffice_sessions_owner_idx ON dyoffice_sessions (deployment_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE dyoffice_password_action_tokens (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  user_id UUID NOT NULL,
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('activate', 'reset')),
  token_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  issued_by UUID,
  FOREIGN KEY (deployment_id, user_id) REFERENCES dyoffice_users (deployment_id, id),
  FOREIGN KEY (deployment_id, issued_by) REFERENCES dyoffice_users (deployment_id, id),
  CONSTRAINT dyoffice_password_action_expiry CHECK (expires_at > created_at)
);
CREATE INDEX dyoffice_password_actions_owner_idx
  ON dyoffice_password_action_tokens (deployment_id, user_id, purpose, expires_at)
  WHERE consumed_at IS NULL;

-- A single row per deployment serializes first-admin initialization transactionally.
-- Initializer must INSERT here and the admin user/role/workspace in ONE transaction;
-- a conflicting INSERT aborts the transaction. Never expose bootstrap over HTTP.
CREATE TABLE dyoffice_admin_bootstrap (
  deployment_id UUID PRIMARY KEY,
  initial_admin_user_id UUID NOT NULL,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (deployment_id, initial_admin_user_id)
    REFERENCES dyoffice_users (deployment_id, id)
);

-- Subsequent migrations T03b/T04 add authorization functions and FORCE RLS.
-- DO NOT connect these tables to public routes without those migrations.
