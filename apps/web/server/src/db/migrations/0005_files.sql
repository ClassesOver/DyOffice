CREATE TABLE storage_accounts (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes>=0),
  stored_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_bytes>=0),
  PRIMARY KEY(deployment_id,owner_id),
  UNIQUE(deployment_id,owner_id,workspace_id),
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id)
);
CREATE TABLE files (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('docx','xlsx','pptx','pdf')),
  current_revision uuid NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,owner_id,id),
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id)
);
CREATE TABLE file_revisions (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 33554432),
  source text NOT NULL DEFAULT 'import' CHECK (source='import'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,owner_id,file_id,id),
  FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id),
  CHECK (object_key=deployment_id::text||'/'||owner_id::text||'/objects/'||id::text)
);
ALTER TABLE files ADD CONSTRAINT files_current_revision_fk FOREIGN KEY(deployment_id,owner_id,id,current_revision)
  REFERENCES file_revisions(deployment_id,owner_id,file_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL UNIQUE,
  revision_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
  format text NOT NULL CHECK (format IN ('docx','xlsx','pptx','pdf')),
  expected_size integer NOT NULL CHECK (expected_size BETWEEN 1 AND 33554432),
  auth_version integer NOT NULL CHECK (auth_version>0),
  state text NOT NULL CHECK (state IN ('staged','receiving','ready','committed','cancelled','expired')),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  attempt_id uuid,
  completed_file_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,owner_id,id),
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES storage_accounts(deployment_id,owner_id,workspace_id),
  FOREIGN KEY(deployment_id,owner_id,completed_file_id) REFERENCES files(deployment_id,owner_id,id),
  CHECK ((state='committed')=(completed_file_id IS NOT NULL)),
  CHECK (completed_file_id IS NULL OR completed_file_id=file_id),
  CHECK (state NOT IN ('ready','committed') OR sha256 IS NOT NULL),
  CHECK (expires_at>created_at)
);
CREATE INDEX uploads_owner_state_expiry ON uploads(deployment_id,owner_id,state,expires_at);
CREATE INDEX files_owner_deleted_id ON files(deployment_id,owner_id,deleted_at,id);
DO $migration$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['storage_accounts','files','file_revisions','uploads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY own_resource ON %I USING (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    ) WITH CHECK (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    )$policy$,relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  END LOOP;
END $migration$;
