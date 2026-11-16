CREATE TABLE personal_preferences (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (deployment_id,owner_id),
  FOREIGN KEY (deployment_id,owner_id,workspace_id) REFERENCES workspaces(deployment_id,owner_id,id) ON DELETE CASCADE
);
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY own_workspace ON workspaces USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
);
ALTER TABLE personal_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY own_preferences ON personal_preferences USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON personal_preferences FROM PUBLIC;

-- Identifier quoting binds each function to this migration's trusted schema.
-- Runtime roles cannot replace it; PUBLIC cannot execute it. Its owner must be
-- a separate non-superuser migration role (checked by runtime admission).
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_business_session(p_deployment uuid,p_hash text,p_idle_ms bigint)
    RETURNS TABLE(user_id uuid,session_id uuid,auth_version integer,roles text[])
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE found_session record; locked_user record; locked_session record; boundary timestamptz;
    BEGIN
      IF p_hash !~ '^[0-9a-f]{64}$' OR p_idle_ms<1 OR p_idle_ms>2592000000 THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      SELECT s.id,s.user_id INTO found_session FROM %1$I.sessions s
        WHERE s.deployment_id=p_deployment AND s.token_hash=p_hash;
      IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
      SELECT u.id,u.status,u.auth_version,u.password_reset_required INTO locked_user
        FROM %1$I.users u WHERE u.deployment_id=p_deployment AND u.id=found_session.user_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
      SELECT s.id,s.token_hash,s.auth_version,s.revoked_at,s.expires_at,s.last_seen_at INTO locked_session
        FROM %1$I.sessions s WHERE s.deployment_id=p_deployment AND s.id=found_session.id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
      boundary:=clock_timestamp();
      IF locked_user.status<>'active' OR locked_user.password_reset_required
        OR locked_session.token_hash<>p_hash OR locked_session.auth_version<>locked_user.auth_version
        OR locked_session.revoked_at IS NOT NULL OR locked_session.expires_at<=boundary
        OR locked_session.last_seen_at<=boundary-p_idle_ms*interval '1 millisecond' THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      RETURN QUERY SELECT locked_user.id,locked_session.id,locked_user.auth_version,
        ARRAY(SELECT r.role FROM %1$I.user_roles r WHERE r.deployment_id=p_deployment AND r.user_id=locked_user.id ORDER BY r.role);
    END
    $function$
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_business_session(uuid,text,bigint) FROM PUBLIC',ns);
END $migration$;
