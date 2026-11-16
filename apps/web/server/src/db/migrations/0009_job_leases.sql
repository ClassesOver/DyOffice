ALTER TABLE edit_leases ADD COLUMN job_id uuid;
ALTER TABLE edit_leases ADD COLUMN job_epoch bigint CHECK(job_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE edit_leases ADD CHECK((job_id IS NULL AND job_epoch IS NULL) OR (job_id IS NOT NULL AND job_epoch IS NOT NULL));
ALTER TABLE edit_leases ADD FOREIGN KEY(deployment_id,owner_id,job_id) REFERENCES native_jobs(deployment_id,owner_id,id);
-- Existing leases retain browser purpose. A public editor UUID is not proof of
-- job provenance, so never infer it from editor_id during an upgrade.
