CREATE TABLE data_sources (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  source_id text NOT NULL CHECK (source_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  enabled boolean NOT NULL DEFAULT true,
  draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version>=1),
  published_revision integer CHECK (published_revision IS NULL OR published_revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,source_id),
  FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE
);

-- Drafts are the editable configuration; every credential reference is kept
-- separately so rotation never mutates a published version's basis.
CREATE TABLE data_source_drafts (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  source_id text NOT NULL,
  version integer NOT NULL CHECK (version>=1),
  kind text NOT NULL CHECK (kind IN ('postgres','http')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200 AND octet_length(name)<=600),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  credential_ref uuid NOT NULL,
  credential_revision integer NOT NULL CHECK (credential_revision>=1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,source_id),
  FOREIGN KEY(deployment_id,owner_id,source_id) REFERENCES data_sources(deployment_id,owner_id,source_id) ON DELETE CASCADE
);

-- Immutable published versions. content_hash covers the public config,
-- the credential revision and the frozen execution parameters, never the DSN.
CREATE TABLE data_source_versions (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  source_id text NOT NULL,
  revision integer NOT NULL CHECK (revision>=1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  kind text NOT NULL CHECK (kind IN ('postgres','http')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
  execution jsonb NOT NULL CHECK (jsonb_typeof(execution)='object'),
  credential_ref uuid NOT NULL,
  credential_revision integer NOT NULL CHECK (credential_revision>=1),
  PRIMARY KEY(deployment_id,owner_id,source_id,revision),
  FOREIGN KEY(deployment_id,owner_id,source_id) REFERENCES data_sources(deployment_id,owner_id,source_id) ON DELETE CASCADE
);
CREATE INDEX data_source_versions_published ON data_source_versions(deployment_id,owner_id,source_id,revision DESC);

-- Append-only credential vault rows. Previous revisions are retained so older
-- published versions stay resolvable after rotation. ciphertext is an
-- A256GCM envelope; secret_hash is a SHA-256 commitment that never leaves storage.
CREATE TABLE data_source_credentials (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  source_id text NOT NULL,
  credential_ref uuid NOT NULL,
  revision integer NOT NULL CHECK (revision>=1),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  ciphertext jsonb NOT NULL CHECK (jsonb_typeof(ciphertext)='object' AND ciphertext->>'algorithm'='A256GCM' AND ciphertext->>'version'='1'),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,source_id,credential_ref),
  UNIQUE(deployment_id,owner_id,source_id,credential_ref,revision),
  FOREIGN KEY(deployment_id,owner_id,source_id) REFERENCES data_sources(deployment_id,owner_id,source_id) ON DELETE CASCADE
);

CREATE TABLE data_source_audit (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  source_id text NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('source_created','source_saved','source_published','source_enabled','source_disabled','source_deleted','source_queried','source_tested')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX data_source_audit_time ON data_source_audit(deployment_id,owner_id,created_at DESC);

DO $migration$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['data_sources','data_source_drafts','data_source_versions','data_source_credentials','data_source_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY own_source_resource ON %I USING (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    ) WITH CHECK (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    )$policy$,relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  END LOOP;
END $migration$;
