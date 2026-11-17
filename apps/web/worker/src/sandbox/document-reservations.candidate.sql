-- TEST CANDIDATE ONLY. Not registered with the application migration manifest.
-- Apply in a dedicated schema with a trusted test owner, never a runtime worker.
CREATE TABLE document_capacity (
 deployment_id uuid PRIMARY KEY,
 slots integer NOT NULL CHECK(slots BETWEEN 1 AND 10000)
);
CREATE TABLE document_job_fences (
 deployment_id uuid NOT NULL REFERENCES document_capacity,
 job_id uuid NOT NULL,
 epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY(deployment_id,job_id)
);
CREATE TABLE document_reservations (
 reservation_id text PRIMARY KEY,
 deployment_id uuid NOT NULL REFERENCES document_capacity,
 job_id uuid NOT NULL,
 attempt bigint NOT NULL CHECK(attempt BETWEEN 1 AND 9007199254740991),
 epoch bigint NOT NULL CHECK(epoch BETWEEN 1 AND 9007199254740991),
 owner_token text NOT NULL CHECK(owner_token ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('reserved','start_intent','bound','quarantined','released')),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 launch_evidence text NOT NULL DEFAULT 'unknown' CHECK(launch_evidence IN ('unknown','not_started','may_started')),
 request jsonb,
 handle jsonb,
 reason text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(deployment_id,job_id,attempt,epoch)
);
CREATE INDEX document_reservation_recovery ON document_reservations(deployment_id,state);
REVOKE ALL ON document_capacity,document_job_fences,document_reservations FROM PUBLIC;

-- Candidate recovery ledger; no broker certification is implied by these records.
CREATE TABLE document_reconcile_tasks (
 reservation_id text PRIMARY KEY REFERENCES document_reservations,
 state text NOT NULL CHECK(state IN ('pending','claimed','blocked','completed')),
 claim_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE document_reconcile_observations (
 claim_id uuid PRIMARY KEY,
 reservation_id text NOT NULL REFERENCES document_reservations,
 owner_token text NOT NULL CHECK(owner_token ~ '^[0-9a-f]{64}$'),
 claimed_version bigint NOT NULL CHECK(claimed_version BETWEEN 1 AND 9007199254740991),
 outcome text CHECK(outcome IN ('released_not_started','blocked_unknown','blocked_uncertified')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_document_launch_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.launch_evidence='may_started' AND NEW.launch_evidence<>'may_started')
    OR (OLD.launch_evidence='unknown' AND NEW.launch_evidence<>'unknown')
    OR (OLD.launch_evidence='not_started' AND NEW.launch_evidence='unknown') THEN
  RAISE EXCEPTION 'launch evidence cannot be downgraded or invented';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_launch_evidence_guard BEFORE UPDATE ON document_reservations
 FOR EACH ROW EXECUTE FUNCTION guard_document_launch_evidence();
REVOKE ALL ON document_reconcile_tasks,document_reconcile_observations FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_document_launch_evidence() FROM PUBLIC;
-- This registry proves only a test identity. It CANNOT certify operating-system stop.
CREATE TABLE document_broker_keys (
 key_id uuid PRIMARY KEY,
 deployment_id uuid NOT NULL REFERENCES document_capacity,
 broker_boot_id uuid NOT NULL,
 public_key bytea NOT NULL CHECK(octet_length(public_key)=44 AND substring(public_key FROM 1 FOR 12)=decode('302a300506032b6570032100','hex')),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true,
 scope text NOT NULL DEFAULT 'test-only' CHECK(scope='test-only'),
 os_stop_certified boolean NOT NULL DEFAULT false CHECK(os_stop_certified=false),
 not_after timestamptz NOT NULL
);
CREATE FUNCTION guard_document_broker_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'broker key identity cannot be reused'; END IF;
 IF NEW.key_id<>OLD.key_id OR NEW.version<>OLD.version THEN RAISE EXCEPTION 'broker key identity/version is controlled'; END IF;
 NEW.version=OLD.version+1;
 RETURN NEW;
END $$;
CREATE TRIGGER document_broker_key_guard BEFORE UPDATE OR DELETE ON document_broker_keys
 FOR EACH ROW EXECUTE FUNCTION guard_document_broker_key();
CREATE TRIGGER document_broker_key_truncate_guard BEFORE TRUNCATE ON document_broker_keys
 FOR EACH STATEMENT EXECUTE FUNCTION guard_document_broker_key();
CREATE TABLE document_broker_challenges (
 challenge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 claim_id uuid NOT NULL UNIQUE REFERENCES document_reconcile_observations,
 key_id uuid NOT NULL REFERENCES document_broker_keys,
 key_version bigint NOT NULL,
 nonce text NOT NULL DEFAULT replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','') CHECK(nonce ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 handle jsonb NOT NULL
);
CREATE TABLE document_broker_receipts (
 challenge_id uuid PRIMARY KEY REFERENCES document_broker_challenges,
 receipt_sha256 text NOT NULL CHECK(receipt_sha256 ~ '^[0-9a-f]{64}$'),
 reported_state text NOT NULL CHECK(reported_state IN ('stopped','unknown')),
 classification text NOT NULL CHECK(classification='authenticated_assertion_os_unverified'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON document_broker_keys,document_broker_challenges,document_broker_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_document_broker_key() FROM PUBLIC;

-- Durable dispatch observations only: no runtime approval or executable grant.
CREATE TABLE document_dispatches (
 reservation_id text PRIMARY KEY REFERENCES document_reservations,
 dispatch_id uuid NOT NULL UNIQUE,
 deployment_id uuid NOT NULL REFERENCES document_capacity,
 reservation_version bigint NOT NULL CHECK(reservation_version BETWEEN 1 AND 9007199254740991),
 owner_token text NOT NULL CHECK(owner_token ~ '^[0-9a-f]{64}$'),
 job_id uuid NOT NULL,
 attempt bigint NOT NULL CHECK(attempt BETWEEN 1 AND 9007199254740991),
 job_epoch bigint NOT NULL CHECK(job_epoch BETWEEN 1 AND 9007199254740991),
 broker_id uuid NOT NULL,
 broker_boot_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,
 challenge_id uuid,
 consumed_at timestamptz,
 CHECK((challenge_id IS NULL)=(consumed_at IS NULL))
);
CREATE FUNCTION guard_document_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'dispatch identity cannot be reused'; END IF;
 IF (to_jsonb(NEW)-'challenge_id'-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'challenge_id'-'consumed_at')
    OR OLD.challenge_id IS NOT NULL OR NEW.challenge_id IS NULL OR NEW.consumed_at IS NULL THEN
  RAISE EXCEPTION 'dispatch identity is immutable and consumption is once only';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_dispatch_guard BEFORE UPDATE OR DELETE ON document_dispatches
 FOR EACH ROW EXECUTE FUNCTION guard_document_dispatch();
CREATE TRIGGER document_dispatch_truncate_guard BEFORE TRUNCATE ON document_dispatches
 FOR EACH STATEMENT EXECUTE FUNCTION guard_document_dispatch();
REVOKE ALL ON document_dispatches FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_document_dispatch() FROM PUBLIC;
DO $candidate$
DECLARE ns text:=current_schema();
BEGIN
EXECUTE replace($ddl$
CREATE FUNCTION __SCHEMA__.document_dispatch_json(d __SCHEMA__.document_dispatches,c text) RETURNS jsonb LANGUAGE sql SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('classification',c,'dispatchId',d.dispatch_id,'reservationId',d.reservation_id,'reservationVersion',d.reservation_version,'requestDigest',d.request_digest,'brokerId',d.broker_id,'brokerBootId',d.broker_boot_id,'expiresAt',to_char(d.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'consumed',d.challenge_id IS NOT NULL)
$fn$;
CREATE FUNCTION __SCHEMA__.document_dispatch_digest(q jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT encode(sha256(convert_to('dyoffice.dispatch.request.v1','UTF8')||decode('00','hex')||convert_to('{'||(SELECT string_agg(to_json(key)::text||':'||value::text,',' ORDER BY key COLLATE "C") FROM jsonb_each(q))||'}','UTF8')),'hex')
$fn$;
CREATE FUNCTION __SCHEMA__.document_dispatch_core(p_id text,p_owner text,p_broker uuid,p_boot uuid,p_dispatch uuid,p_challenge uuid,p_mode text) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE v __SCHEMA__.document_reservations; d __SCHEMA__.document_dispatches; fence bigint; result text;
BEGIN
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 IF v.reservation_id IS NULL THEN RAISE EXCEPTION 'DOCUMENT_RESERVATION_OWNER'; END IF;
 PERFORM 1 FROM __SCHEMA__.document_capacity WHERE deployment_id=v.deployment_id FOR UPDATE;
 SELECT * INTO v FROM __SCHEMA__.document_reservations WHERE reservation_id=p_id;
 SELECT * INTO d FROM __SCHEMA__.document_dispatches WHERE reservation_id=p_id;
 IF p_mode='history' THEN RETURN CASE WHEN d.reservation_id IS NULL THEN NULL ELSE __SCHEMA__.document_dispatch_json(d,'historical_dispatch_observation') END; END IF;
 IF v.owner_token IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'DOCUMENT_RESERVATION_OWNER'; END IF;
 SELECT epoch INTO fence FROM __SCHEMA__.document_job_fences WHERE deployment_id=v.deployment_id AND job_id=v.job_id;
 IF v.request IS NULL OR fence IS DISTINCT FROM v.epoch THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_FENCED'; END IF;
 IF (v.request->>'deadlineAt')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_EXPIRED'; END IF;
 IF p_mode='prepare' THEN
  IF v.state<>'reserved' OR v.launch_evidence<>'not_started' OR v.handle IS NOT NULL OR d.reservation_id IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_STATE'; END IF;
  IF p_broker IS NULL OR p_boot IS NULL THEN RAISE EXCEPTION 'INVALID_DISPATCH_BROKER'; END IF;
  UPDATE __SCHEMA__.document_reservations SET state='start_intent',launch_evidence='may_started',version=version+1,updated_at=clock_timestamp() WHERE reservation_id=p_id RETURNING * INTO v;
  INSERT INTO __SCHEMA__.document_reconcile_tasks(reservation_id,state) VALUES(p_id,'pending') ON CONFLICT(reservation_id) DO UPDATE SET state='pending',claim_id=NULL,updated_at=clock_timestamp();
  INSERT INTO __SCHEMA__.document_dispatches(reservation_id,dispatch_id,deployment_id,reservation_version,owner_token,job_id,attempt,job_epoch,broker_id,broker_boot_id,request_digest,expires_at) VALUES(p_id,gen_random_uuid(),v.deployment_id,v.version,p_owner,v.job_id,v.attempt,v.epoch,p_broker,p_boot,__SCHEMA__.document_dispatch_digest(v.request),(v.request->>'deadlineAt')::timestamptz) RETURNING * INTO d;
  result:='prepared_dispatch_observation';
 ELSIF p_mode='consume' THEN
  IF d.dispatch_id IS DISTINCT FROM p_dispatch OR d.owner_token IS DISTINCT FROM p_owner OR d.reservation_version<>v.version OR v.state<>'start_intent' OR v.launch_evidence<>'may_started' OR v.handle IS NOT NULL OR d.job_id<>v.job_id OR d.attempt<>v.attempt OR d.job_epoch<>v.epoch OR d.broker_id IS DISTINCT FROM p_broker OR d.broker_boot_id IS DISTINCT FROM p_boot OR d.request_digest<>__SCHEMA__.document_dispatch_digest(v.request) OR d.expires_at IS DISTINCT FROM (v.request->>'deadlineAt')::timestamptz OR p_challenge IS NULL THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_BINDING'; END IF;
  IF d.challenge_id IS NOT NULL AND d.challenge_id<>p_challenge THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_CONSUMED'; END IF;
  result:=CASE WHEN d.challenge_id IS NULL THEN 'first_consumed_observation' ELSE 'already_consumed' END;
  IF d.challenge_id IS NULL THEN UPDATE __SCHEMA__.document_dispatches SET challenge_id=p_challenge,consumed_at=clock_timestamp() WHERE reservation_id=p_id RETURNING * INTO d; END IF;
 ELSE RAISE EXCEPTION 'INVALID_DISPATCH_MODE'; END IF;
 IF d.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'DOCUMENT_DISPATCH_EXPIRED'; END IF;
 RETURN __SCHEMA__.document_dispatch_json(d,result);
END $fn$;
REVOKE ALL ON FUNCTION __SCHEMA__.document_dispatch_json(__SCHEMA__.document_dispatches,text),__SCHEMA__.document_dispatch_digest(jsonb),__SCHEMA__.document_dispatch_core(text,text,uuid,uuid,uuid,uuid,text) FROM PUBLIC;
$ddl$,'__SCHEMA__',quote_ident(ns));
END $candidate$;
