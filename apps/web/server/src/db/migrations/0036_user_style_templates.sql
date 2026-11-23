CREATE TABLE user_style_templates (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  topic text NOT NULL CHECK (octet_length(topic) <= 4096),
  style_skill text NOT NULL CHECK (octet_length(style_skill) BETWEEN 1 AND 262144),
  created_at timestamptz NOT NULL,
  layout jsonb CHECK (layout IS NULL OR (jsonb_typeof(layout)='object' AND octet_length(layout::text) <= 65536)),
  PRIMARY KEY (deployment_id,owner_id,name),
  FOREIGN KEY (deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id) ON DELETE CASCADE
);
ALTER TABLE user_style_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_style_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY own_style_template ON user_style_templates USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND global_config_authorized(deployment_id,false)
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND global_config_authorized(deployment_id,false)
);
REVOKE ALL ON user_style_templates FROM PUBLIC;
