ALTER TABLE sessions ADD CONSTRAINT sessions_owned_id_key UNIQUE(deployment_id,user_id,id);
ALTER TABLE uploads DROP CONSTRAINT uploads_file_id_key;
ALTER TABLE uploads ADD COLUMN kind text NOT NULL DEFAULT 'import' CHECK (kind IN ('import','revision'));
ALTER TABLE uploads ADD COLUMN base_revision uuid;
ALTER TABLE uploads ADD COLUMN lease_epoch bigint CHECK (lease_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE uploads ADD COLUMN editor_id uuid;
ALTER TABLE uploads ADD COLUMN session_id uuid;
ALTER TABLE uploads ADD COLUMN restored_from uuid;
ALTER TABLE uploads ADD CONSTRAINT uploads_owned_file_id_key UNIQUE(deployment_id,owner_id,file_id,id);
ALTER TABLE uploads ADD CONSTRAINT uploads_revision_shape CHECK (
  (kind='import' AND base_revision IS NULL AND lease_epoch IS NULL AND editor_id IS NULL AND session_id IS NULL AND restored_from IS NULL)
  OR (kind='revision' AND base_revision IS NOT NULL AND lease_epoch IS NOT NULL AND editor_id IS NOT NULL AND session_id IS NOT NULL)
);
ALTER TABLE uploads ADD FOREIGN KEY(deployment_id,owner_id,file_id,base_revision) REFERENCES file_revisions(deployment_id,owner_id,file_id,id);
ALTER TABLE uploads ADD FOREIGN KEY(deployment_id,owner_id,file_id,restored_from) REFERENCES file_revisions(deployment_id,owner_id,file_id,id);
ALTER TABLE uploads ADD FOREIGN KEY(deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id);
ALTER TABLE file_revisions DROP CONSTRAINT file_revisions_source_check;
ALTER TABLE file_revisions ADD COLUMN parent_revision uuid;
ALTER TABLE file_revisions ADD COLUMN restored_from uuid;
ALTER TABLE file_revisions ADD CONSTRAINT file_revisions_source_check CHECK (source IN ('import','save','restore'));
ALTER TABLE file_revisions ADD CONSTRAINT file_revisions_parent_shape CHECK (
  (source='import' AND parent_revision IS NULL AND restored_from IS NULL)
  OR (source='save' AND parent_revision IS NOT NULL AND restored_from IS NULL)
  OR (source='restore' AND parent_revision IS NOT NULL AND restored_from IS NOT NULL)
);
ALTER TABLE file_revisions ADD FOREIGN KEY(deployment_id,owner_id,file_id,parent_revision) REFERENCES file_revisions(deployment_id,owner_id,file_id,id);
ALTER TABLE file_revisions ADD FOREIGN KEY(deployment_id,owner_id,file_id,restored_from) REFERENCES file_revisions(deployment_id,owner_id,file_id,id);
CREATE INDEX file_revisions_history ON file_revisions(deployment_id,owner_id,file_id,created_at DESC,id DESC);
CREATE TABLE edit_leases (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_id uuid NOT NULL,
  session_id uuid NOT NULL,
  auth_version integer NOT NULL CHECK (auth_version>0),
  editor_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(deployment_id,owner_id,file_id),
  FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id),
  FOREIGN KEY(deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id)
);
CREATE TABLE revision_commits (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  upload_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  base_revision uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch BETWEEN 1 AND 9007199254740991),
  requested_source_command_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,file_id,idempotency_key),
  UNIQUE(deployment_id,owner_id,file_id,revision_id),
  FOREIGN KEY(deployment_id,owner_id,file_id,upload_id) REFERENCES uploads(deployment_id,owner_id,file_id,id),
  FOREIGN KEY(deployment_id,owner_id,file_id,revision_id) REFERENCES file_revisions(deployment_id,owner_id,file_id,id),
  FOREIGN KEY(deployment_id,owner_id,file_id,base_revision) REFERENCES file_revisions(deployment_id,owner_id,file_id,id)
);
CREATE TABLE revision_outbox (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  file_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type='file.revision.committed'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  UNIQUE(deployment_id,owner_id,file_id,revision_id,event_type),
  FOREIGN KEY(deployment_id,owner_id,file_id,revision_id) REFERENCES file_revisions(deployment_id,owner_id,file_id,id)
);
DO $migration$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['edit_leases','revision_commits','revision_outbox'] LOOP
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
