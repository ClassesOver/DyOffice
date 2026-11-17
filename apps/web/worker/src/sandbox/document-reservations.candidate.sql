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
