-- Add bounded keyset access to retained, attributable history. The legacy
-- latest-20 function remains unchanged. Runtime receives no audit table SELECT.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.read_login_history_page(p_deployment uuid,p_hash text,p_idle_ms bigint,p_limit integer,p_after uuid)
    RETURNS TABLE(event_id uuid,occurred_at timestamptz,outcome text)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE principal record; anchor_time timestamptz;
    BEGIN
      IF p_deployment IS NULL OR p_hash IS NULL OR p_idle_ms IS NULL THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      SELECT * INTO STRICT principal FROM %1$I.lock_business_session(p_deployment,p_hash,p_idle_ms);
      IF p_limit IS NULL OR p_limit < 1 OR p_limit > 20 THEN
        RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023';
      END IF;
      IF p_after IS NOT NULL THEN
        SELECT e.created_at INTO anchor_time FROM %1$I.auth_security_events e
        WHERE e.deployment_id=p_deployment
          AND ((e.event='login_succeeded' AND e.actor_id=principal.user_id)
            OR (e.event IN ('login_failed','login_throttled') AND
              (e.subject_user_id=principal.user_id OR (e.subject_user_id IS NULL AND e.actor_id=principal.user_id))))
          AND e.id=p_after;
        IF NOT FOUND THEN RAISE EXCEPTION 'Invalid history page' USING ERRCODE='22023'; END IF;
      END IF;
      RETURN QUERY SELECT e.id,e.created_at,
        CASE e.event WHEN 'login_succeeded' THEN 'success' WHEN 'login_failed' THEN 'failure' ELSE 'throttled' END
        FROM %1$I.auth_security_events e
        WHERE e.deployment_id=p_deployment
          AND ((e.event='login_succeeded' AND e.actor_id=principal.user_id)
            OR (e.event IN ('login_failed','login_throttled') AND
              (e.subject_user_id=principal.user_id OR (e.subject_user_id IS NULL AND e.actor_id=principal.user_id))))
          AND (p_after IS NULL OR (e.created_at,e.id)<(anchor_time,p_after))
        ORDER BY e.created_at DESC,e.id DESC LIMIT p_limit+1;
    END
    $function$
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.read_login_history_page(uuid,text,bigint,integer,uuid) FROM PUBLIC',ns);
END
$migration$;
