-- A file's visible conversation is independent of any browser, editor lease or revision.
CREATE TABLE file_assistant_messages (
  deployment_id uuid NOT NULL, owner_id uuid NOT NULL, file_id uuid NOT NULL,
  turn_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')),
  sender text CHECK(sender IS NULL OR (sender='dsh' AND role='user')),
  body text NOT NULL CHECK(length(body)<=24000),
  state text NOT NULL CHECK(state IN ('streaming','done','failed')),
  seq integer NOT NULL CHECK(seq>=0), position bigint NOT NULL CHECK(position>0),
  changed bigint NOT NULL CHECK(changed>=position),
  PRIMARY KEY(deployment_id,owner_id,file_id,turn_id,role),
  UNIQUE(deployment_id,owner_id,file_id,changed),
  FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id)
);
ALTER TABLE file_assistant_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_assistant_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY own_file_chat ON file_assistant_messages USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON file_assistant_messages FROM PUBLIC;
