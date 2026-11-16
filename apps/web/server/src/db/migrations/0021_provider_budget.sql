-- Trusted provisioning only: no account means zero available budget. Amounts are
-- integer internal accounting units, not a claim of exact vendor token pricing.
CREATE TABLE provider_budget_accounts (
 deployment_id uuid NOT NULL, owner_id uuid NOT NULL, entry_id text NOT NULL,
 config_revision integer NOT NULL CHECK(config_revision>=0),
 available_units bigint NOT NULL DEFAULT 0 CHECK(available_units BETWEEN 0 AND 9007199254740991),
 per_call_units bigint NOT NULL CHECK(per_call_units BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(deployment_id,owner_id,entry_id,config_revision),
 FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id)
);
CREATE TABLE provider_budget_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deployment_id uuid NOT NULL, owner_id uuid NOT NULL,
 session_id uuid NOT NULL, turn_id text NOT NULL CHECK(turn_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 entry_id text NOT NULL, config_revision integer NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 amount_units bigint NOT NULL CHECK(amount_units BETWEEN 1 AND 9007199254740991),
 state text NOT NULL CHECK(state IN ('reserved','dispatching','unknown','settled','cancelled')),
 claim_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(deployment_id,owner_id,session_id,turn_id),
 FOREIGN KEY(deployment_id,owner_id,entry_id,config_revision) REFERENCES provider_budget_accounts(deployment_id,owner_id,entry_id,config_revision),
 CHECK((state IN ('reserved','cancelled') AND claim_id IS NULL) OR (state IN ('dispatching','unknown','settled') AND claim_id IS NOT NULL))
);
DO $migration$
DECLARE ns text:=current_schema(); rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['provider_budget_accounts','provider_budget_reservations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',rel);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',rel);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',rel);
  -- Only the trusted migration/provisioning owner and its audited SECURITY
  -- DEFINER function can access the ledgers. Runtime gets no table privileges.
  EXECUTE format('CREATE POLICY budget_owner ON %I USING (current_user=%L) WITH CHECK (current_user=%L)',rel,current_user,current_user);
 END LOOP;
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.provider_budget_action(p_action text,p_turn text,p_entry text,p_revision integer,p_digest text,p_claim uuid DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid;
 usr uuid:=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid;
 sid uuid:=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid;
 a %1$I.provider_budget_accounts%%ROWTYPE; r %1$I.provider_budget_reservations%%ROWTYPE;
 BEGIN
  IF dep IS NULL OR usr IS NULL OR sid IS NULL OR NOT %1$I.global_config_authorized(dep,true)
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
  IF NOT %1$I.global_config_authorized(dep,true) THEN RAISE EXCEPTION 'Provider budget unavailable' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('id',r.id,'claimId',r.claim_id,'deploymentId',dep,'userId',usr,'sessionId',sid,'turnId',r.turn_id,'entryId',r.entry_id,'configRevision',r.config_revision,'requestDigest',r.request_digest,'amount',r.amount_units,'state',r.state);
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.provider_budget_action(text,text,text,integer,text,uuid) FROM PUBLIC',ns);
END $migration$;
