-- SaaS models are shared; dispatch receipts remain bound to the acting session.
CREATE TABLE shared_provider_dispatches (
 deployment_id uuid NOT NULL, owner_id uuid NOT NULL, session_id uuid NOT NULL,
 turn_id text NOT NULL, entry_id text NOT NULL, config_revision integer NOT NULL,
 request_digest text NOT NULL, state text NOT NULL CHECK(state IN ('dispatching','settled')),
 credential_released_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(deployment_id,owner_id,session_id,turn_id)
);
ALTER TABLE shared_provider_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_provider_dispatches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON shared_provider_dispatches FROM PUBLIC;
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format('CREATE POLICY shared_dispatch_owner ON shared_provider_dispatches USING (current_user=%L) WITH CHECK (current_user=%L)',current_user,current_user);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.shared_provider_catalog()
 RETURNS TABLE(revision integer,id text,label text,provider_id text,model text,base_url text,preferred boolean)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT g.revision,e.id,e.label,e.provider_id,e.model,e.base_url,COALESCE(g.defaults->>'chat'=e.id,false)
 FROM %1$I.global_configs g JOIN %1$I.global_config_entries e ON e.deployment_id=g.deployment_id
 JOIN %1$I.global_config_secrets s ON s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id
 WHERE g.deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
 AND e.enabled AND e.kind='chat' AND %1$I.global_config_authorized(g.deployment_id,false)
 AND EXISTS(SELECT 1 FROM %1$I.user_roles r WHERE r.deployment_id=g.deployment_id AND r.user_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid AND r.role='personal')
 ORDER BY e.id
 $fn$;
 CREATE FUNCTION %1$I.shared_provider_dispatch(p_action text,p_turn text,p_entry text,p_revision integer,p_digest text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid;
 usr uuid:=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid;
 sid uuid:=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid;
 BEGIN
 IF NOT %1$I.global_config_authorized(dep,false) OR NOT EXISTS(SELECT 1 FROM %1$I.user_roles WHERE deployment_id=dep AND user_id=usr AND role='personal')
 OR p_turn IS NULL OR p_turn !~ '^[A-Za-z0-9_-]{1,128}$' OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 IF p_action='claim' THEN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
 IF NOT EXISTS(SELECT 1 FROM %1$I.shared_provider_catalog() WHERE id=p_entry AND revision=p_revision)
 THEN RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 INSERT INTO %1$I.shared_provider_dispatches(deployment_id,owner_id,session_id,turn_id,entry_id,config_revision,request_digest,state)
 VALUES(dep,usr,sid,p_turn,p_entry,p_revision,p_digest,'dispatching');
 ELSIF p_action='settle' THEN
 UPDATE %1$I.shared_provider_dispatches SET state='settled' WHERE deployment_id=dep AND owner_id=usr AND session_id=sid AND turn_id=p_turn AND entry_id=p_entry AND config_revision=p_revision AND request_digest=p_digest AND state='dispatching';
 IF NOT FOUND THEN RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 END $fn$;
 CREATE FUNCTION %1$I.shared_provider_secret(p_turn text,p_entry text,p_revision integer,p_digest text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid; result jsonb;
 BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
 IF NOT EXISTS(SELECT 1 FROM %1$I.shared_provider_dispatches WHERE deployment_id=dep AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid AND turn_id=p_turn AND entry_id=p_entry AND config_revision=p_revision AND request_digest=p_digest AND state='dispatching')
 OR NOT EXISTS(SELECT 1 FROM %1$I.shared_provider_catalog() WHERE id=p_entry AND revision=p_revision)
 THEN RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 UPDATE %1$I.shared_provider_dispatches SET credential_released_at=clock_timestamp() WHERE deployment_id=dep AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid AND turn_id=p_turn AND credential_released_at IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Shared provider unavailable' USING ERRCODE='42501'; END IF;
 SELECT envelope INTO result FROM %1$I.global_config_secrets WHERE deployment_id=dep AND entry_id=p_entry AND kind='chat';
 RETURN result;
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.shared_provider_catalog() FROM PUBLIC',ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.shared_provider_dispatch(text,text,text,integer,text) FROM PUBLIC',ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.shared_provider_secret(text,text,integer,text) FROM PUBLIC',ns);
END $migration$;
