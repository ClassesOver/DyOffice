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
 request jsonb,
 handle jsonb,
 reason text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(deployment_id,job_id,attempt,epoch)
);
CREATE INDEX document_reservation_recovery ON document_reservations(deployment_id,state);
REVOKE ALL ON document_capacity,document_job_fences,document_reservations FROM PUBLIC;
