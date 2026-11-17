-- Separate physical-object budget, deliberately NOT Office file accounting.
-- Unknown uploads remain charged until a verified physical removal succeeds.
CREATE TABLE harness_artifact_accounts (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes BETWEEN 0 AND 16777216),
  PRIMARY KEY(deployment_id,owner_id),
  FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id) ON DELETE RESTRICT
);
CREATE TABLE harness_artifact_tasks (
  task_id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  epoch integer NOT NULL CHECK(epoch>0),
  state text NOT NULL DEFAULT 'staging' CHECK(state IN ('staging','committed','cancelled')),
  UNIQUE(deployment_id,owner_id,task_id),
  FOREIGN KEY(deployment_id,owner_id) REFERENCES harness_artifact_accounts(deployment_id,owner_id) ON DELETE RESTRICT
);
CREATE TABLE harness_artifacts (
  artifact_id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  task_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  media_type text NOT NULL CHECK(length(media_type) BETWEEN 1 AND 120),
  role text NOT NULL CHECK(length(role) BETWEEN 1 AND 64),
  input_result_ids jsonb NOT NULL CHECK(jsonb_typeof(input_result_ids)='array'),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','ready','committed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,owner_id,artifact_id),
  FOREIGN KEY(deployment_id,owner_id,task_id) REFERENCES harness_artifact_tasks(deployment_id,owner_id,task_id) ON DELETE RESTRICT
);
CREATE INDEX harness_artifacts_task ON harness_artifacts(deployment_id,owner_id,task_id);
CREATE TABLE harness_analysis_deliveries (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  command_id uuid NOT NULL,
  task_id uuid NOT NULL,
  params_hash text NOT NULL CHECK(params_hash ~ '^[0-9a-f]{64}$'),
  receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,command_id),
  UNIQUE(deployment_id,owner_id,task_id),
  FOREIGN KEY(deployment_id,owner_id,task_id) REFERENCES harness_artifact_tasks(deployment_id,owner_id,task_id) ON DELETE RESTRICT
);
ALTER TABLE harness_artifact_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_artifact_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_artifact_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_artifact_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_analysis_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_analysis_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY own_harness_artifact_account ON harness_artifact_accounts USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
CREATE POLICY own_harness_artifact_task ON harness_artifact_tasks USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
CREATE POLICY own_harness_artifact ON harness_artifacts USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
CREATE POLICY own_harness_analysis_delivery ON harness_analysis_deliveries USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON harness_artifact_accounts,harness_artifact_tasks,harness_artifacts,harness_analysis_deliveries FROM PUBLIC;
