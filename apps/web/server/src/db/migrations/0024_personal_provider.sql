-- Personal consumption uses independent owner-bound accounts. The admin-only
-- budget function and secret policy remain in place. No default credit is added.
ALTER TABLE provider_budget_reservations ADD COLUMN credential_released_at timestamptz;

DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.personal_provider_budget_action(p_action text,p_turn text,p_entry text,p_revision integer,p_digest text,p_claim uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid;
 usr uuid:=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid;
 sid uuid:=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid;
 a %1$I.provider_budget_accounts%%ROWTYPE; r %1$I.provider_budget_reservations%%ROWTYPE;
 BEGIN
  IF NOT EXISTS(SELECT 1 FROM %1$I.user_roles WHERE deployment_id=dep AND user_id=usr AND role='personal')
    OR dep IS NULL OR usr IS NULL OR sid IS NULL OR NOT %1$I.global_config_authorized(dep,false)
    OR p_action IS NULL OR p_action NOT IN ('reserve','claim','dispatch','unknown','settle','cancel','status','verify')
    OR p_turn IS NULL OR p_turn !~ '^[A-Za-z0-9_-]{1,128}$' OR p_entry IS NULL OR p_entry !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$'
    OR p_revision IS NULL OR p_revision<0 OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  -- Match T12 writer lock, held to transaction commit. A config edit cannot
  -- slip between eligibility checking and the committed dispatch intent.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
  IF p_action IN ('reserve','claim','dispatch','verify') AND NOT EXISTS(
   SELECT 1 FROM %1$I.global_configs g JOIN %1$I.global_config_entries e ON e.deployment_id=g.deployment_id
   WHERE g.deployment_id=dep AND g.revision=p_revision AND e.id=p_entry AND e.enabled AND e.kind='chat'
  ) THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  -- Global lock order: config -> account -> reservation. Accounts are shared
  -- across sessions, preventing concurrent admissions from overspending.
  SELECT * INTO a FROM %1$I.provider_budget_accounts WHERE deployment_id=dep AND owner_id=usr AND entry_id=p_entry AND config_revision=p_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM %1$I.provider_budget_reservations WHERE deployment_id=dep AND owner_id=usr AND session_id=sid AND turn_id=p_turn FOR UPDATE;
  IF FOUND AND (r.entry_id<>p_entry OR r.config_revision<>p_revision OR r.request_digest<>p_digest) THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  IF p_action='reserve' THEN
   IF r.id IS NULL THEN
    IF a.available_units<a.per_call_units THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    UPDATE %1$I.provider_budget_accounts SET available_units=available_units-a.per_call_units WHERE deployment_id=dep AND owner_id=usr AND entry_id=p_entry AND config_revision=p_revision;
    INSERT INTO %1$I.provider_budget_reservations(deployment_id,owner_id,session_id,turn_id,entry_id,config_revision,request_digest,amount_units,state)
    VALUES(dep,usr,sid,p_turn,p_entry,p_revision,p_digest,a.per_call_units,'reserved') RETURNING * INTO r;
   END IF;
  ELSE
   IF r.id IS NULL THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
   IF p_action='claim' THEN
    IF r.state<>'reserved' OR p_claim IS NULL THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    UPDATE %1$I.provider_budget_reservations SET state='dispatching',claim_id=p_claim,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
   ELSIF p_action IN ('dispatch','unknown','settle','verify') THEN
    IF p_claim IS NULL OR r.claim_id IS DISTINCT FROM p_claim THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    IF p_action IN ('dispatch','verify') AND r.state<>'dispatching' THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    IF p_action='unknown' AND r.state NOT IN ('dispatching','unknown') THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    IF p_action='settle' AND r.state NOT IN ('unknown','settled') THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    IF p_action<>'verify' THEN
     UPDATE %1$I.provider_budget_reservations SET state=CASE WHEN p_action='settle' THEN 'settled' ELSE 'unknown' END,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
    END IF;
   ELSIF p_action='cancel' THEN
    IF r.state NOT IN ('reserved','cancelled') THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
    IF r.state='reserved' THEN
     UPDATE %1$I.provider_budget_accounts SET available_units=available_units+r.amount_units WHERE deployment_id=dep AND owner_id=usr AND entry_id=p_entry AND config_revision=p_revision;
     UPDATE %1$I.provider_budget_reservations SET state='cancelled',updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
    END IF;
   END IF;
  END IF;
  -- Wall clock expiry can cross while waiting for either ledger lock.
  IF NOT %1$I.global_config_authorized(dep,false) THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('id',r.id,'claimId',r.claim_id,'deploymentId',dep,'userId',usr,'sessionId',sid,'turnId',r.turn_id,'entryId',r.entry_id,'configRevision',r.config_revision,'requestDigest',r.request_digest,'amount',r.amount_units,'state',r.state);
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.personal_provider_budget_action(text,text,text,integer,text,uuid) FROM PUBLIC',ns);
 -- Only the trusted migration owner (including the function below) gains this
 -- read policy. The business login still cannot SELECT another role's secrets.
 EXECUTE format('CREATE POLICY secret_provisioning_owner ON global_config_secrets FOR SELECT USING (current_user=%L)',current_user);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.personal_provider_secret(p_turn text,p_entry text,p_revision integer,p_digest text,p_claim uuid,p_reservation uuid)
 RETURNS TABLE(revision integer,id text,kind text,provider_id text,model text,base_url text,enabled boolean,envelope jsonb)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid;
 usr uuid:=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid;
 sid uuid:=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid;
 BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
  IF NOT %1$I.global_config_authorized(dep,false) OR NOT EXISTS(SELECT 1 FROM %1$I.user_roles WHERE deployment_id=dep AND user_id=usr AND role='personal')
  THEN RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501'; END IF;
  UPDATE %1$I.provider_budget_reservations r SET credential_released_at=clock_timestamp()
   WHERE r.deployment_id=dep AND r.owner_id=usr AND r.session_id=sid
    AND r.id=p_reservation AND r.turn_id=p_turn AND r.entry_id=p_entry AND r.config_revision=p_revision AND r.request_digest=p_digest AND r.claim_id=p_claim
    AND r.state='unknown' AND r.credential_released_at IS NULL;
  IF NOT FOUND OR NOT %1$I.global_config_authorized(dep,false)
  THEN RAISE EXCEPTION 'Provider credential unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT g.revision,e.id,e.kind,e.provider_id,e.model,e.base_url,e.enabled,s.envelope
   FROM %1$I.global_configs g JOIN %1$I.global_config_entries e ON e.deployment_id=g.deployment_id
   JOIN %1$I.global_config_secrets s ON s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id
   WHERE g.deployment_id=dep AND g.revision=p_revision AND e.id=p_entry AND e.enabled AND e.kind='chat';
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.personal_provider_secret(text,text,integer,text,uuid,uuid) FROM PUBLIC',ns);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.personal_provider_catalog()
 RETURNS TABLE(revision integer,id text,label text,provider_id text,model text,base_url text,preferred boolean)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT g.revision,e.id,e.label,e.provider_id,e.model,e.base_url,COALESCE(g.defaults->>'chat'=e.id,false)
  FROM %1$I.global_configs g JOIN %1$I.global_config_entries e ON e.deployment_id=g.deployment_id
  JOIN %1$I.provider_budget_accounts a ON a.deployment_id=g.deployment_id AND a.config_revision=g.revision AND a.entry_id=e.id
  JOIN %1$I.global_config_secrets s ON s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id
  WHERE g.deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
   AND a.owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
   AND a.available_units>=a.per_call_units AND e.enabled AND e.kind='chat'
   AND %1$I.global_config_authorized(g.deployment_id,false)
  ORDER BY e.id
 $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.personal_provider_catalog() FROM PUBLIC',ns);
END $migration$;
