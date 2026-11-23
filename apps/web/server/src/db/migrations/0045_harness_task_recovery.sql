CREATE TABLE harness_task_recovery (
  deployment_id uuid NOT NULL, owner_id uuid NOT NULL, session_id uuid NOT NULL,
  file_id uuid NOT NULL, turn_id text NOT NULL CHECK(turn_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  state text NOT NULL CHECK(state IN ('running','cancel_requested','succeeded','failed','unknown_outcome')),
  status_payload text NOT NULL CHECK(octet_length(status_payload)<=524288),
  checkpoint text CHECK(octet_length(checkpoint)<=262656),
  lease_until timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(deployment_id,owner_id,session_id,turn_id),
  FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id)
);
CREATE INDEX harness_recovery_file ON harness_task_recovery(deployment_id,owner_id,file_id);
ALTER TABLE harness_task_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_task_recovery FORCE ROW LEVEL SECURITY;
CREATE POLICY own_harness_recovery ON harness_task_recovery USING (
  deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON harness_task_recovery FROM PUBLIC;
