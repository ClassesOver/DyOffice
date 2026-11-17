-- Bounded, frozen small query evidence in PostgreSQL JSONB, NOT object storage.
-- Its canonical logical size has an independent workspace quota; do not charge
-- T05 storage_accounts.stored_bytes (physical object bytes) for these rows.
CREATE TABLE workspace_source_results (
  result_id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_id text NOT NULL,
  source_version integer NOT NULL CHECK (source_version>=1),
  query_hash text NOT NULL CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 10000),
  truncated boolean NOT NULL,
  -- Canonical UTF-8 JSON bytes, including the evidence hash; not pg_column_size.
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1000000),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','saved')),
  session_id uuid,
  name text CHECK (
    length(name) BETWEEN 1 AND 200 AND octet_length(name)<=240
    AND name=btrim(name) AND name NOT IN ('.','..')
    AND name !~ '[[:cntrl:]/\\:*?"<>|]' AND name !~ '[. ]$'
    AND name !~* '^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)'
  ),
  save_command_id uuid,
  save_params_hash text CHECK (save_params_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  saved_at timestamptz,
  UNIQUE(deployment_id,owner_id,workspace_id,result_id),
  -- A single permanent receipt per artifact is bounded by saved-result quota.
  UNIQUE(deployment_id,owner_id,workspace_id,save_command_id),
  FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id) ON DELETE CASCADE,
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id) ON DELETE CASCADE,
  -- Source roots/versions are permanent history. Logical source deletion does
  -- not revoke an owner's explicitly saved personal materialization.
  FOREIGN KEY(deployment_id,owner_id,source_id) REFERENCES data_sources(deployment_id,owner_id,source_id) ON DELETE RESTRICT,
  FOREIGN KEY(deployment_id,owner_id,source_id,source_version) REFERENCES data_source_versions(deployment_id,owner_id,source_id,revision) ON DELETE RESTRICT,
  CHECK (
    (state='pending' AND session_id IS NOT NULL AND expires_at IS NOT NULL
      AND name IS NULL AND save_command_id IS NULL AND save_params_hash IS NULL AND saved_at IS NULL)
    OR (state='saved' AND session_id IS NULL AND expires_at IS NULL
      AND name IS NOT NULL AND save_command_id IS NOT NULL AND save_params_hash IS NOT NULL AND saved_at IS NOT NULL)
  )
);
-- Metadata/keyset/expiry indexes only: never a GIN index duplicating row JSONB.
CREATE INDEX workspace_source_results_saved ON workspace_source_results(deployment_id,owner_id,workspace_id,result_id) WHERE state='saved';
CREATE INDEX workspace_source_results_pending_expiry ON workspace_source_results(deployment_id,owner_id,workspace_id,expires_at,result_id) WHERE state='pending';
CREATE INDEX workspace_source_results_source ON workspace_source_results(deployment_id,owner_id,source_id,source_version);
ALTER TABLE workspace_source_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_source_results FORCE ROW LEVEL SECURITY;
CREATE POLICY own_workspace_source_result ON workspace_source_results USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON workspace_source_results FROM PUBLIC;
