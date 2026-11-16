CREATE TABLE workspace_folders (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  parent_id uuid,
  name text NOT NULL CHECK (
    length(name) BETWEEN 1 AND 100 AND octet_length(name)<=255
    AND name=btrim(name) AND name NOT IN ('.','..')
    AND name !~ '[[:cntrl:]/\\]'
  ),
  name_key text GENERATED ALWAYS AS (lower(name)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,owner_id,id),
  CONSTRAINT workspace_folders_sibling_name UNIQUE NULLS NOT DISTINCT(deployment_id,owner_id,parent_id,name_key),
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(deployment_id,owner_id,parent_id) REFERENCES workspace_folders(deployment_id,owner_id,id) ON DELETE RESTRICT,
  CHECK(parent_id IS NULL OR parent_id<>id)
);

-- Missing rows mean an unfiled, unstarred file that has never been opened.
-- A file's existing trash/restore operations leave this state intact.
CREATE TABLE workspace_file_state (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  folder_id uuid,
  starred boolean NOT NULL DEFAULT false,
  last_opened_at timestamptz,
  PRIMARY KEY(deployment_id,owner_id,file_id),
  FOREIGN KEY(deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(deployment_id,owner_id,folder_id) REFERENCES workspace_folders(deployment_id,owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX workspace_file_state_folder ON workspace_file_state(deployment_id,owner_id,folder_id,file_id);
CREATE INDEX workspace_file_state_recent ON workspace_file_state(deployment_id,owner_id,last_opened_at DESC,file_id) WHERE last_opened_at IS NOT NULL;
CREATE INDEX workspace_file_state_starred ON workspace_file_state(deployment_id,owner_id,file_id) WHERE starred;

DO $migration$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['workspace_folders','workspace_file_state'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY own_workspace_resource ON %I USING (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    ) WITH CHECK (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    )$policy$,relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  END LOOP;
END $migration$;

