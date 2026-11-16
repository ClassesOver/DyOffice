CREATE TABLE global_configs (
  deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  defaults jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(defaults)='object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE global_config_entries (
  deployment_id uuid NOT NULL REFERENCES global_configs(deployment_id) ON DELETE CASCADE,
  id text NOT NULL CHECK (id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$'),
  kind text NOT NULL CHECK (kind IN ('chat','image_generation','image_analysis','video_analysis','web_search','image_search','rerank','http_mcp')),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  model text NOT NULL CHECK (length(model)<=256),
  base_url text NOT NULL CHECK (length(base_url)<=2048),
  enabled boolean NOT NULL,
  PRIMARY KEY(deployment_id,id),
  UNIQUE(deployment_id,id,kind,provider_id)
);
CREATE TABLE global_config_secrets (
  deployment_id uuid NOT NULL,
  entry_id text NOT NULL,
  kind text NOT NULL,
  provider_id text NOT NULL,
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope)='object' AND envelope->>'keyId'=key_id AND envelope->>'algorithm'='A256GCM' AND envelope->>'version'='1'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,entry_id),
  FOREIGN KEY(deployment_id,entry_id,kind,provider_id) REFERENCES global_config_entries(deployment_id,id,kind,provider_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
-- Deliberately no arbitrary details/URL/body column: audits cannot store API keys.
CREATE TABLE global_config_audit (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('config_saved','config_checked','key_rotated')),
  revision integer NOT NULL CHECK (revision>=0),
  entry_ids text[] NOT NULL CHECK (cardinality(entry_ids)<=200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(deployment_id,actor_id) REFERENCES users(deployment_id,id)
);
CREATE INDEX global_config_audit_deployment_time ON global_config_audit(deployment_id,created_at DESC);

DO $migration$
DECLARE ns text:=current_schema(); relation text;
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.global_config_authorized(p_deployment uuid,p_admin boolean)
    RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
      SELECT p_deployment=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
        AND EXISTS (
          SELECT 1 FROM %1$I.sessions s JOIN %1$I.users u ON u.deployment_id=s.deployment_id AND u.id=s.user_id
          WHERE s.deployment_id=p_deployment
            AND s.id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid
            AND s.user_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
            AND s.token_hash=NULLIF(current_setting('dyoffice.global_session_hash',true),'')
            AND u.status='active' AND NOT u.password_reset_required
            AND s.auth_version=u.auth_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
            AND NULLIF(current_setting('dyoffice.global_idle_ms',true),'')::bigint BETWEEN 1 AND 2592000000
            AND s.last_seen_at>clock_timestamp()-NULLIF(current_setting('dyoffice.global_idle_ms',true),'')::bigint*interval '1 millisecond'
            AND (NOT p_admin OR EXISTS(SELECT 1 FROM %1$I.user_roles r WHERE r.deployment_id=u.deployment_id AND r.user_id=u.id AND r.role='config_admin'))
        )
    $function$
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.global_config_authorized(uuid,boolean) FROM PUBLIC',ns);
  FOREACH relation IN ARRAY ARRAY['global_configs','global_config_entries','global_config_secrets','global_config_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  END LOOP;
  EXECUTE format('CREATE POLICY global_read ON global_configs FOR SELECT USING (%I.global_config_authorized(deployment_id,false))',ns);
  EXECUTE format('CREATE POLICY global_write ON global_configs FOR INSERT WITH CHECK (%I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY global_update ON global_configs FOR UPDATE USING (%1$I.global_config_authorized(deployment_id,true)) WITH CHECK (%1$I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY entry_read ON global_config_entries FOR SELECT USING (%1$I.global_config_authorized(deployment_id,true) OR (enabled AND %1$I.global_config_authorized(deployment_id,false)))',ns);
  EXECUTE format('CREATE POLICY entry_insert ON global_config_entries FOR INSERT WITH CHECK (%I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY entry_update ON global_config_entries FOR UPDATE USING (%1$I.global_config_authorized(deployment_id,true)) WITH CHECK (%1$I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY entry_delete ON global_config_entries FOR DELETE USING (%I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY secret_admin ON global_config_secrets USING (%1$I.global_config_authorized(deployment_id,true)) WITH CHECK (%1$I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format('CREATE POLICY audit_admin_read ON global_config_audit FOR SELECT USING (%I.global_config_authorized(deployment_id,true))',ns);
  EXECUTE format($policy$CREATE POLICY audit_admin_insert ON global_config_audit FOR INSERT WITH CHECK (
    %I.global_config_authorized(deployment_id,true)
    AND actor_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
    AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid
  )$policy$,ns);
END $migration$;

