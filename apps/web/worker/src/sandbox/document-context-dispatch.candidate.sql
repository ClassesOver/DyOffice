-- Unregistered, test-only composition. Requires native/unified/reservation/restricted candidates.
-- It does not certify a runtime or change the unavailable production backend.
DO $candidate$
DECLARE ns text:=current_schema(); relation text;
BEGIN
EXECUTE replace($ddl$
CREATE TABLE __SCHEMA__.document_dispatch_context_bindings (
 reservation_id text PRIMARY KEY REFERENCES __SCHEMA__.document_reservations,
 context_id uuid NOT NULL REFERENCES __SCHEMA__.document_execution_contexts,
 context_version bigint NOT NULL CHECK(context_version BETWEEN 1 AND 9007199254740991)
);
REVOKE ALL ON __SCHEMA__.document_dispatch_context_bindings FROM PUBLIC;
CREATE TRIGGER document_dispatch_context_immutable BEFORE UPDATE OR DELETE ON __SCHEMA__.document_dispatch_context_bindings
 FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();
CREATE TRIGGER document_dispatch_context_no_truncate BEFORE TRUNCATE ON __SCHEMA__.document_dispatch_context_bindings
 FOR EACH STATEMENT EXECUTE FUNCTION __SCHEMA__.deny_dispatch_binding_change();

-- Private helper: uses only the immutable recorded context and private native claim.
CREATE FUNCTION __SCHEMA__.document_check_dispatch_context(p_dispatch uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE d __SCHEMA__.document_dispatches; b __SCHEMA__.document_dispatch_context_bindings;
 n __SCHEMA__.document_dispatch_native_bindings; v __SCHEMA__.document_reservations; proof jsonb;
BEGIN
 SELECT * INTO d FROM __SCHEMA__.document_dispatches WHERE dispatch_id=p_dispatch;
 SELECT * INTO b FROM __SCHEMA__.document_dispatch_context_bindings WHERE reservation_id=d.reservation_id;
 SELECT * INTO n FROM __SCHEMA__.document_dispatch_native_bindings WHERE dispatch_id=p_dispatch;
 IF d.dispatch_id IS NULL OR b.reservation_id IS NULL OR n.dispatch_id IS NULL THEN RAISE EXCEPTION 'Context dispatch denied' USING ERRCODE='28000'; END IF;
 proof:=__SCHEMA__.document_verify_context(b.context_id,b.context_version,n.claim_hash,'before_start');
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=d.reservation_id;
 IF proof->'request' IS DISTINCT FROM v.request OR (proof->>'remainingMs')::bigint<=0 OR d.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Context dispatch denied' USING ERRCODE='28000'; END IF;
END $fn$;

-- Enforce context fencing even if a caller uses the older native consume API.
-- An exact replay through that older API remains historical "already_consumed",
-- never context_verified. New API rechecks even replays below.
CREATE FUNCTION __SCHEMA__.guard_context_dispatch_consume() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM __SCHEMA__.document_dispatch_context_bindings WHERE reservation_id=OLD.reservation_id) THEN
  PERFORM __SCHEMA__.document_check_dispatch_context(OLD.dispatch_id);
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER document_context_dispatch_consume_guard BEFORE UPDATE ON __SCHEMA__.document_dispatches
 FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.guard_context_dispatch_consume();

CREATE FUNCTION __SCHEMA__.document_context_dispatch_issue(p_id text,p_hash text,p_consumer uuid,p_context uuid,p_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE a __SCHEMA__.document_dispatch_assignments; i __SCHEMA__.document_dispatch_roles;
 v __SCHEMA__.document_reservations; ctx __SCHEMA__.document_execution_contexts; proof jsonb; result jsonb;
BEGIN
 -- Reject unrelated login before private context/native authorization can take victim locks.
 SELECT * INTO a FROM __SCHEMA__.document_dispatch_assignments WHERE reservation_id=p_id;
 SELECT * INTO i FROM __SCHEMA__.document_dispatch_roles WHERE id=a.issuer_id;
 IF a.reservation_id IS NULL OR i.role_oid IS DISTINCT FROM __SCHEMA__.document_dispatch_login_oid() OR NOT i.active OR i.version<>a.issuer_version OR a.consumer_id IS DISTINCT FROM p_consumer THEN RAISE EXCEPTION 'Context dispatch denied' USING ERRCODE='28000'; END IF;
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 SELECT * INTO ctx FROM __SCHEMA__.document_execution_contexts WHERE id=p_context;
 -- Unlocked request prefilter prevents selecting a foreign context's native locks.
 -- The authoritative context and reservation are still rechecked below.
 IF ctx.id IS NULL OR ctx.version IS DISTINCT FROM p_version OR ctx.request IS DISTINCT FROM v.request THEN RAISE EXCEPTION 'Context dispatch denied' USING ERRCODE='28000'; END IF;
 proof:=__SCHEMA__.document_verify_context(p_context,p_version,p_hash,'pre');
 IF proof->'request' IS DISTINCT FROM v.request OR (proof->>'remainingMs')::bigint<=0 THEN RAISE EXCEPTION 'Context dispatch denied' USING ERRCODE='28000'; END IF;
 INSERT INTO __SCHEMA__.document_dispatch_context_bindings VALUES(p_id,p_context,p_version);
 result:=__SCHEMA__.document_native_dispatch_issue(p_id,p_hash,p_consumer);
 -- Existing native issue locks/rechecks assignment, principal, lease and capacity.
 -- Recheck context after those waits; any exception rolls back both transition and binding.
 PERFORM __SCHEMA__.document_check_dispatch_context((result->>'dispatchId')::uuid);
 RETURN result||jsonb_build_object('classification','context_verified_prepared_observation');
END $fn$;

CREATE FUNCTION __SCHEMA__.document_context_dispatch_consume(p_dispatch uuid,p_challenge uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE result jsonb;
BEGIN
 -- Native entry performs login prefilter before private credentials/locks; trigger
 -- fences the first transition. A failed final check also rolls back that transition.
 result:=__SCHEMA__.document_native_dispatch_consume(p_dispatch,p_challenge);
 PERFORM __SCHEMA__.document_check_dispatch_context(p_dispatch);
 IF result->>'classification'='native_verified_first_consumed_observation' THEN
  result:=result||jsonb_build_object('classification','context_verified_first_consumed_observation');
 END IF;
 RETURN result;
END $fn$;
$ddl$,'__SCHEMA__',quote_ident(ns));
FOR relation IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=ns AND p.proname IN ('document_check_dispatch_context','guard_context_dispatch_consume','document_context_dispatch_issue','document_context_dispatch_consume') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',relation);
END LOOP;
END $candidate$;
