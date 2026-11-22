-- Ordered public events of a Harness task, read by the browser from any API
-- instance. Removed together with the task's recovery row.
CREATE TABLE harness_task_events (
  deployment_id uuid NOT NULL, owner_id uuid NOT NULL, session_id uuid NOT NULL,
  turn_id text NOT NULL,
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 4096),
  kind text NOT NULL CHECK(kind IN ('state','activity','progress')),
  payload text NOT NULL CHECK(octet_length(payload)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,session_id,turn_id,sequence),
  FOREIGN KEY(deployment_id,owner_id,session_id,turn_id) REFERENCES harness_task_recovery(deployment_id,owner_id,session_id,turn_id) ON DELETE CASCADE
);
ALTER TABLE harness_task_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_task_events FORCE ROW LEVEL SECURITY;
CREATE POLICY own_harness_task_events ON harness_task_events USING (
  deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON harness_task_events FROM PUBLIC;
