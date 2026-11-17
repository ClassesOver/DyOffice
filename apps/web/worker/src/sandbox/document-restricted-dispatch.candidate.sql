-- Candidate only; install as a non-superuser, NOBYPASSRLS schema owner.
DO $candidate$
DECLARE ns text:=current_schema();
BEGIN
EXECUTE replace($ddl$
CREATE TABLE __SCHEMA__.document_dispatch_roles (
 id uuid PRIMARY KEY, role_oid oid NOT NULL UNIQUE, deployment_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('issuer','consumer')), version bigint NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true, broker_id uuid, broker_boot_id uuid,
 CHECK((purpose='issuer' AND broker_id IS NULL AND broker_boot_id IS NULL) OR (purpose='consumer' AND broker_id IS NOT NULL AND broker_boot_id IS NOT NULL))
);
CREATE TABLE __SCHEMA__.document_dispatch_assignments (
 reservation_id text PRIMARY KEY REFERENCES __SCHEMA__.document_reservations,
 issuer_id uuid NOT NULL REFERENCES __SCHEMA__.document_dispatch_roles,
 issuer_version bigint NOT NULL,consumer_id uuid NOT NULL REFERENCES __SCHEMA__.document_dispatch_roles,
 consumer_version bigint NOT NULL,owner_token text NOT NULL,reservation_version bigint NOT NULL
);
CREATE TABLE __SCHEMA__.document_dispatch_native_bindings (
 dispatch_id uuid PRIMARY KEY REFERENCES __SCHEMA__.document_dispatches(dispatch_id),
 native_facts jsonb NOT NULL,claim_hash text NOT NULL CHECK(claim_hash ~ '^[0-9a-f]{64}$')
);
CREATE FUNCTION __SCHEMA__.guard_dispatch_registration() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'registration identity cannot be reused'; END IF;
 IF (to_jsonb(NEW)-'active'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'active'-'version') OR NEW.version<>OLD.version OR OLD.active=false OR NEW.active<>false THEN RAISE EXCEPTION 'registration only permits one-way revoke'; END IF;
 NEW.version:=OLD.version+1;RETURN NEW;
END $fn$;
CREATE TRIGGER dispatch_role_guard BEFORE UPDATE OR DELETE ON __SCHEMA__.document_dispatch_roles FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.guard_dispatch_registration();
CREATE TRIGGER dispatch_role_truncate BEFORE TRUNCATE ON __SCHEMA__.document_dispatch_roles FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.guard_dispatch_registration();
CREATE FUNCTION __SCHEMA__.deny_dispatch_binding_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$ BEGIN RAISE EXCEPTION 'dispatch binding immutable'; END $fn$;
CREATE TRIGGER assignment_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.document_dispatch_assignments FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();
CREATE TRIGGER assignment_truncate BEFORE TRUNCATE ON __SCHEMA__.document_dispatch_assignments FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();
CREATE TRIGGER native_binding_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.document_dispatch_native_bindings FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();
CREATE TRIGGER native_binding_truncate BEFORE TRUNCATE ON __SCHEMA__.document_dispatch_native_bindings FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();
CREATE FUNCTION __SCHEMA__.document_dispatch_login_oid() RETURNS oid LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
 SELECT a.usesysid FROM pg_stat_activity a JOIN pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid() AND a.usename=session_user AND r.rolname=session_user
$fn$;
CREATE FUNCTION __SCHEMA__.document_assign_dispatch(p_id text,p_issuer uuid,p_consumer uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE v __SCHEMA__.document_reservations;i __SCHEMA__.document_dispatch_roles;c __SCHEMA__.document_dispatch_roles;
BEGIN
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 PERFORM 1 FROM __SCHEMA__.document_capacity WHERE deployment_id=v.deployment_id FOR UPDATE;
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=p_issuer FOR SHARE;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=p_consumer FOR SHARE;
 IF v.reservation_id IS NULL OR v.state<>'reserved' OR v.launch_evidence<>'not_started' OR i.purpose IS DISTINCT FROM 'issuer' OR c.purpose IS DISTINCT FROM 'consumer' OR NOT i.active OR NOT c.active OR i.deployment_id<>v.deployment_id OR c.deployment_id<>v.deployment_id THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 INSERT INTO __SCHEMA__.document_dispatch_assignments VALUES(p_id,i.id,i.version,c.id,c.version,v.owner_token,v.version);
END $fn$;
CREATE FUNCTION __SCHEMA__.document_dispatch_native_facts(p_deploy uuid,p_job uuid,p_epoch bigint,p_hash text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE j __SCHEMA__.native_jobs;l __SCHEMA__.edit_leases;r __SCHEMA__.file_revisions;facts jsonb;
BEGIN
 PERFORM __SCHEMA__.lock_job_principal(p_deploy,p_job,p_epoch,p_hash,false);
 SELECT * INTO j FROM __SCHEMA__.native_jobs WHERE deployment_id=p_deploy AND id=p_job;
 SELECT * INTO l FROM __SCHEMA__.edit_leases WHERE deployment_id=p_deploy AND owner_id=j.owner_id AND file_id=j.file_id;
 SELECT * INTO r FROM __SCHEMA__.file_revisions WHERE deployment_id=p_deploy AND owner_id=j.owner_id AND file_id=j.file_id AND id=j.artifact_id;
 facts:=jsonb_build_object('deploymentId',j.deployment_id,'ownerId',j.owner_id,'sessionId',j.session_id,'authVersion',j.auth_version,'fileId',j.file_id,'baseRevision',j.artifact_id,'jobId',j.id,'jobEpoch',j.claim_epoch,'attempt',j.attempts,'editorId',l.editor_id,'leaseEpoch',l.lease_epoch,'inputSha256',r.sha256,'inputSize',r.size,'jobType',j.type);
 PERFORM __SCHEMA__.document_native_authority(facts,p_hash);RETURN facts;
END $fn$;
CREATE FUNCTION __SCHEMA__.document_native_dispatch_issue(p_id text,p_hash text,p_consumer uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE hint __SCHEMA__.document_reservations;v __SCHEMA__.document_reservations;a __SCHEMA__.document_dispatch_assignments;i __SCHEMA__.document_dispatch_roles;c __SCHEMA__.document_dispatch_roles;facts jsonb;result jsonb;key text;
BEGIN
 SELECT * INTO hint FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 IF hint.reservation_id IS NULL THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 -- Unlocked caller prefilter prevents using another principal's credentials/locks.
 -- It is not authoritative: all bindings are re-read under locks below.
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=p_id;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=a.issuer_id;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=a.consumer_id;
 IF a.reservation_id IS NULL OR i.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR NOT i.active OR NOT c.active OR i.version<>a.issuer_version OR c.version<>a.consumer_version OR c.id IS DISTINCT FROM p_consumer OR a.owner_token<>hint.owner_token OR a.reservation_version<>hint.version THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 facts:=__SCHEMA__.document_dispatch_native_facts(hint.deployment_id,hint.job_id,hint.epoch,p_hash);
 PERFORM 1 FROM __SCHEMA__.document_capacity WHERE deployment_id=hint.deployment_id FOR UPDATE;
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=p_id FOR SHARE;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=a.issuer_id FOR SHARE;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=a.consumer_id FOR SHARE;
 IF to_jsonb(v) IS DISTINCT FROM to_jsonb(hint) OR a.reservation_id IS NULL OR i.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR i.purpose IS DISTINCT FROM 'issuer' OR c.purpose IS DISTINCT FROM 'consumer' OR NOT i.active OR NOT c.active OR i.version<>a.issuer_version OR c.version<>a.consumer_version OR c.id IS DISTINCT FROM p_consumer OR i.deployment_id<>v.deployment_id OR c.deployment_id<>v.deployment_id OR a.owner_token<>v.owner_token OR a.reservation_version<>v.version OR v.request->>'actorId' IS DISTINCT FROM facts->>'ownerId' OR v.request->>'profileId' IS DISTINCT FROM split_part(facts->>'jobType','.',1)||'-edit-v1' THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 FOREACH key IN ARRAY ARRAY['deploymentId','jobId','jobEpoch','attempt','fileId','baseRevision','editorId','leaseEpoch','inputSha256','inputSize'] LOOP
  IF v.request->key IS DISTINCT FROM facts->key THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 END LOOP;
 result:=__SCHEMA__.document_dispatch_core(p_id,v.owner_token,c.broker_id,c.broker_boot_id,NULL,NULL,'prepare');
 INSERT INTO __SCHEMA__.document_dispatch_native_bindings VALUES((result->>'dispatchId')::uuid,facts,p_hash);
 PERFORM __SCHEMA__.document_native_authority(facts,p_hash);
 IF (result->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 RETURN result||jsonb_build_object('classification','native_verified_prepared_observation');
END $fn$;
CREATE FUNCTION __SCHEMA__.document_native_dispatch_consume(p_dispatch uuid,p_challenge uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE hint __SCHEMA__.document_dispatches;d __SCHEMA__.document_dispatches;b __SCHEMA__.document_dispatch_native_bindings;a __SCHEMA__.document_dispatch_assignments;i __SCHEMA__.document_dispatch_roles;c __SCHEMA__.document_dispatch_roles;result jsonb;
BEGIN
 SELECT * INTO hint FROM __SCHEMA__.document_dispatches WHERE dispatch_id=p_dispatch;
 SELECT * INTO b FROM __SCHEMA__.document_dispatch_native_bindings WHERE dispatch_id=p_dispatch;
 IF hint.dispatch_id IS NULL OR b.dispatch_id IS NULL THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=hint.reservation_id;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=a.issuer_id;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=a.consumer_id;
 IF a.reservation_id IS NULL OR c.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR NOT i.active OR NOT c.active OR i.version<>a.issuer_version OR c.version<>a.consumer_version OR c.deployment_id<>hint.deployment_id THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 PERFORM __SCHEMA__.document_native_authority(b.native_facts,b.claim_hash);
 PERFORM 1 FROM __SCHEMA__.document_capacity WHERE deployment_id=hint.deployment_id FOR UPDATE;
 SELECT * INTO d FROM __SCHEMA__.document_dispatches WHERE dispatch_id=p_dispatch;
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=d.reservation_id FOR SHARE;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=a.issuer_id FOR SHARE;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=a.consumer_id FOR SHARE;
 IF d.reservation_id IS DISTINCT FROM hint.reservation_id OR c.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR NOT i.active OR NOT c.active OR i.version<>a.issuer_version OR c.version<>a.consumer_version OR c.deployment_id<>d.deployment_id OR i.deployment_id<>d.deployment_id OR d.broker_id<>c.broker_id OR d.broker_boot_id<>c.broker_boot_id OR d.owner_token<>a.owner_token OR d.reservation_version<>a.reservation_version+1 THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 result:=__SCHEMA__.document_dispatch_core(d.reservation_id,d.owner_token,c.broker_id,c.broker_boot_id,p_dispatch,p_challenge,'consume');
 PERFORM __SCHEMA__.document_native_authority(b.native_facts,b.claim_hash);
 IF (result->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 IF result->>'classification'='first_consumed_observation' THEN result:=result||jsonb_build_object('classification','native_verified_first_consumed_observation'); END IF;
 RETURN result;
END $fn$;
CREATE FUNCTION __SCHEMA__.document_native_dispatch_history(p_dispatch uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE d __SCHEMA__.document_dispatches;c __SCHEMA__.document_dispatch_roles;a __SCHEMA__.document_dispatch_assignments;
BEGIN
 SELECT * INTO d FROM __SCHEMA__.document_dispatches WHERE dispatch_id=p_dispatch;
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=d.reservation_id;
 SELECT * INTO c FROM __SCHEMA__.document_dispatch_roles WHERE id=a.consumer_id;
 IF d.dispatch_id IS NULL OR c.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR NOT c.active OR c.version<>a.consumer_version OR c.deployment_id<>d.deployment_id THEN RAISE EXCEPTION 'Restricted dispatch denied' USING ERRCODE='28000'; END IF;
 RETURN __SCHEMA__.document_dispatch_json(d,'historical_dispatch_observation');
END $fn$;
REVOKE ALL ON __SCHEMA__.document_dispatch_roles,__SCHEMA__.document_dispatch_assignments,__SCHEMA__.document_dispatch_native_bindings FROM PUBLIC;
REVOKE ALL ON FUNCTION __SCHEMA__.document_dispatch_login_oid(),__SCHEMA__.guard_dispatch_registration(),__SCHEMA__.deny_dispatch_binding_change(),__SCHEMA__.document_assign_dispatch(text,uuid,uuid),__SCHEMA__.document_dispatch_native_facts(uuid,uuid,bigint,text),__SCHEMA__.document_native_dispatch_issue(text,text,uuid),__SCHEMA__.document_native_dispatch_consume(uuid,uuid),__SCHEMA__.document_native_dispatch_history(uuid) FROM PUBLIC;
$ddl$,'__SCHEMA__',quote_ident(ns));
END $candidate$;
