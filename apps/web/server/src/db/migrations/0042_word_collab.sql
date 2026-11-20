-- A revision with no checkpoint starts a new collaboration history.
ALTER TABLE file_revisions ADD COLUMN word_epoch uuid;
ALTER TABLE file_revisions ADD COLUMN word_version integer;
ALTER TABLE file_revisions ADD CONSTRAINT word_checkpoint CHECK (
  (word_epoch IS NULL AND word_version IS NULL) OR
  (word_epoch IS NOT NULL AND word_version IS NOT NULL AND word_version >= 0)
);
CREATE TABLE word_collab_steps (
  deployment_id uuid NOT NULL, owner_id uuid NOT NULL, file_id uuid NOT NULL,
  epoch uuid NOT NULL, version integer NOT NULL CHECK(version > 0),
  client_id uuid NOT NULL, step jsonb NOT NULL CHECK(jsonb_typeof(step)='object'),
  PRIMARY KEY(deployment_id,owner_id,file_id,epoch,version),
  FOREIGN KEY(deployment_id,owner_id,file_id,epoch)
    REFERENCES file_revisions(deployment_id,owner_id,file_id,id)
);
ALTER TABLE word_collab_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE word_collab_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY own_word_steps ON word_collab_steps USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON word_collab_steps FROM PUBLIC;
