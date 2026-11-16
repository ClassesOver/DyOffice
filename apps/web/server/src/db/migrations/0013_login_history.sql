-- Read a fixed, minimal history without granting runtime access to raw audit.
-- Historical hash-only failures cannot be safely attributed after name reuse.
CREATE INDEX auth_login_actor_history ON auth_security_events(deployment_id,actor_id,created_at DESC,id DESC)
  WHERE event IN ('login_succeeded','login_failed','login_throttled');
CREATE INDEX auth_login_subject_history ON auth_security_events(deployment_id,subject_user_id,created_at DESC,id DESC)
  WHERE event IN ('login_failed','login_throttled');
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.read_login_history(p_deployment uuid,p_hash text,p_idle_ms bigint)
    RETURNS TABLE(occurred_at timestamptz,outcome text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE principal record;
    BEGIN
      -- Reuse the live-credential guard: user -> session SHARE locks, DB time,
      -- deployment, version, disabled/reset, expiry and idle revalidation.
      IF p_deployment IS NULL OR p_hash IS NULL OR p_idle_ms IS NULL THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      SELECT * INTO STRICT principal FROM %1$I.lock_business_session(p_deployment,p_hash,p_idle_ms);
      RETURN QUERY SELECT e.created_at,
        CASE e.event WHEN 'login_succeeded' THEN 'success' WHEN 'login_failed' THEN 'failure' ELSE 'throttled' END
        FROM %1$I.auth_security_events e
        WHERE e.deployment_id=p_deployment
          AND ((e.event='login_succeeded' AND e.actor_id=principal.user_id)
            OR (e.event IN ('login_failed','login_throttled') AND
              (e.subject_user_id=principal.user_id OR (e.subject_user_id IS NULL AND e.actor_id=principal.user_id))))
        ORDER BY e.created_at DESC,e.id DESC LIMIT 20;
    END
    $function$
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.read_login_history(uuid,text,bigint) FROM PUBLIC',ns);
END
$migration$;
