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
