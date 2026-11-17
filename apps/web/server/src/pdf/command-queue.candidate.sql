-- Candidate only: explicitly installed in disposable tests, NOT a migration.
CREATE TABLE pdf_job_commands (
 deployment_id uuid NOT NULL, owner_id uuid NOT NULL, job_id uuid NOT NULL,
 command_json text NOT NULL CHECK(octet_length(command_json)<=16384),
 command_digest text NOT NULL CHECK(command_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(deployment_id,owner_id,job_id),
 FOREIGN KEY(deployment_id,owner_id,job_id) REFERENCES native_jobs(deployment_id,owner_id,id),
 CHECK(command_digest=encode(sha256(convert_to(command_json,'UTF8')),'hex')),
 CHECK((command_json::jsonb->>'version'='1' AND command_json::jsonb->>'action'='rotatePages' AND jsonb_typeof(command_json::jsonb->'operations')='array') IS TRUE)
);
ALTER TABLE pdf_job_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE pdf_job_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY own_pdf_command ON pdf_job_commands USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
 AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
 AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON pdf_job_commands FROM PUBLIC;
