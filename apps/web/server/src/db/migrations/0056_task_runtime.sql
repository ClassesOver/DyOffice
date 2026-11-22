-- Keep the existing row identities, foreign keys and executor-specific constraints.
-- Inheritance exposes the common fields once, without copying the payloads or
-- allocating empty channel columns on every Codex row.
ALTER TABLE assistant_tasks RENAME TO task_runtime_channel;
ALTER TABLE harness_task_recovery RENAME TO task_runtime_codex;
ALTER TABLE assistant_background_queue RENAME TO task_background_claims;

-- Capture the previous column sets before adding the common runtime fields.
CREATE VIEW assistant_tasks WITH (security_invoker=true) AS SELECT * FROM task_runtime_channel;
CREATE VIEW harness_task_recovery WITH (security_invoker=true) AS SELECT * FROM task_runtime_codex;
CREATE VIEW assistant_background_queue WITH (security_invoker=true) AS SELECT * FROM task_background_claims;

CREATE TABLE task_runtime (
 runtime_id uuid NOT NULL DEFAULT gen_random_uuid(),
 deployment_id uuid NOT NULL, owner_id uuid NOT NULL, state text NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false, lease_until timestamptz, renewed_at timestamptz,
 CONSTRAINT task_runtime_state CHECK (state IN ('queued','running','waiting_peer','cancel_requested','succeeded','failed','cancelled','unknown_outcome')),
 -- Only the executor relations admit new rows. The parent is for common reads and transitions.
 CHECK (false) NO INHERIT
);
ALTER TABLE task_runtime_channel
 ADD COLUMN runtime_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 ADD COLUMN lease_until timestamptz, ADD COLUMN renewed_at timestamptz,
 ADD CONSTRAINT task_runtime_state CHECK (state IN ('queued','running','waiting_peer','cancel_requested','succeeded','failed','cancelled','unknown_outcome'));
ALTER TABLE task_runtime_codex
 ADD COLUMN runtime_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
 ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false, ADD COLUMN renewed_at timestamptz,
 ADD CONSTRAINT task_runtime_state CHECK (state IN ('queued','running','waiting_peer','cancel_requested','succeeded','failed','cancelled','unknown_outcome'));
ALTER TABLE task_runtime_channel INHERIT task_runtime;
ALTER TABLE task_runtime_codex INHERIT task_runtime;
ALTER TABLE task_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_runtime FORCE ROW LEVEL SECURITY;
CREATE POLICY own_runtime ON task_runtime USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND
 owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON task_runtime, assistant_tasks, harness_task_recovery, assistant_background_queue FROM PUBLIC;

-- Old in-flight Codex cancellations have no separate flag. Migration owners
-- normally cannot see these rows under FORCE RLS.
DO $migration$
BEGIN
 EXECUTE format('CREATE POLICY upgrade_runtime ON task_runtime_codex TO %I USING(true) WITH CHECK(true)',current_user);
 UPDATE task_runtime_codex SET cancel_requested=true WHERE state='cancel_requested';
 DROP POLICY upgrade_runtime ON task_runtime_codex;
END $migration$;
