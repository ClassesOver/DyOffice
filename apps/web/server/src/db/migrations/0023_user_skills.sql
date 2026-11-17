CREATE TABLE user_skills (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$'),
  description text NOT NULL CHECK (octet_length(description) <= 4096),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 262144),
  PRIMARY KEY (deployment_id, owner_id, name),
  FOREIGN KEY (deployment_id, owner_id, workspace_id) REFERENCES workspaces(deployment_id, owner_id, id) ON DELETE CASCADE
);
ALTER TABLE user_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY own_skill ON user_skills USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND global_config_authorized(deployment_id,false)
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND global_config_authorized(deployment_id,false)
);
REVOKE ALL ON user_skills FROM PUBLIC;
