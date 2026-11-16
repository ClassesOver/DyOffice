-- T04 row-level security.
-- 0003_files.sql and 0004_revisions.sql stay as they were applied. This
-- migration is the ownership policy. The migration role remains the table
-- owner so it can apply DDL. Request traffic must not use that role.
-- db/context.mjs enters dyoffice_app with SET LOCAL ROLE and
-- set_config('app.current_user', ..., true) after BEGIN. A missing setting
-- matches no row. Roles do not grant file ownership.
-- dyoffice_auth may read and update credential tables before a principal
-- exists. It is not granted files, revisions, workspaces, or the outbox.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyoffice_app') THEN
    CREATE ROLE dyoffice_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyoffice_auth') THEN
    CREATE ROLE dyoffice_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$roles$;

GRANT dyoffice_app TO CURRENT_USER;
GRANT dyoffice_auth TO CURRENT_USER;

CREATE OR REPLACE FUNCTION public.dyoffice_current_actor()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.current_user', true), '') $$;

CREATE OR REPLACE FUNCTION public.dyoffice_current_deployment()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.current_deployment', true), '') $$;

REVOKE ALL ON FUNCTION public.dyoffice_current_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dyoffice_current_deployment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dyoffice_current_actor() TO dyoffice_app, dyoffice_auth;
GRANT EXECUTE ON FUNCTION public.dyoffice_current_deployment() TO dyoffice_app, dyoffice_auth;

ALTER TABLE dyoffice_personal_workspaces
  ADD CONSTRAINT dyoffice_workspace_scope UNIQUE (deployment_id, owner_user_id, id);

ALTER TABLE dyoffice_files
  ADD CONSTRAINT dyoffice_files_scope UNIQUE (deployment_id, owner_user_id, id);

ALTER TABLE dyoffice_files
  ADD COLUMN workspace_id UUID;

ALTER TABLE dyoffice_files
  ADD CONSTRAINT dyoffice_files_workspace_owner_fk
  FOREIGN KEY (deployment_id, owner_user_id, workspace_id)
  REFERENCES dyoffice_personal_workspaces (deployment_id, owner_user_id, id);

ALTER TABLE dyoffice_personal_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_personal_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_files FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_files FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_file_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_file_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_edit_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_edit_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_uploads FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_revision_idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_users FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_user_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_password_action_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_password_action_tokens FORCE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_admin_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE dyoffice_admin_bootstrap FORCE ROW LEVEL SECURITY;

CREATE POLICY dyoffice_workspaces_owner ON dyoffice_personal_workspaces
  FOR ALL TO dyoffice_app
  USING (
    owner_user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  )
  WITH CHECK (
    owner_user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  );

CREATE POLICY dyoffice_files_owner ON dyoffice_files
  FOR ALL TO dyoffice_app
  USING (
    owner_user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  )
  WITH CHECK (
    owner_user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  );

CREATE POLICY dyoffice_revision_files_owner ON dyoffice_revision_files
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_file_revisions_owner ON dyoffice_file_revisions
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_edit_leases_owner ON dyoffice_edit_leases
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_revision_uploads_owner ON dyoffice_revision_uploads
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_revision_idempotency_owner ON dyoffice_revision_idempotency
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_outbox_owner ON dyoffice_outbox
  FOR ALL TO dyoffice_app
  USING (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment())
  WITH CHECK (owner_id = public.dyoffice_current_actor() AND deployment_id = public.dyoffice_current_deployment());

CREATE POLICY dyoffice_users_self ON dyoffice_users
  FOR SELECT TO dyoffice_app
  USING (
    id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  );

CREATE POLICY dyoffice_users_auth_lookup ON dyoffice_users
  FOR SELECT TO dyoffice_auth
  USING (true);

CREATE POLICY dyoffice_user_roles_self ON dyoffice_user_roles
  FOR SELECT TO dyoffice_app
  USING (
    user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  );

CREATE POLICY dyoffice_user_roles_auth_lookup ON dyoffice_user_roles
  FOR SELECT TO dyoffice_auth
  USING (true);

CREATE POLICY dyoffice_sessions_self ON dyoffice_sessions
  FOR SELECT TO dyoffice_app
  USING (
    user_id::text = public.dyoffice_current_actor()
    AND deployment_id::text = public.dyoffice_current_deployment()
  );

CREATE POLICY dyoffice_sessions_auth ON dyoffice_sessions
  FOR ALL TO dyoffice_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY dyoffice_password_actions_auth ON dyoffice_password_action_tokens
  FOR ALL TO dyoffice_auth
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE
  dyoffice_users,
  dyoffice_user_roles,
  dyoffice_personal_workspaces,
  dyoffice_sessions,
  dyoffice_password_action_tokens,
  dyoffice_admin_bootstrap,
  dyoffice_login_rate_buckets,
  dyoffice_files,
  dyoffice_revision_files,
  dyoffice_file_revisions,
  dyoffice_edit_leases,
  dyoffice_revision_uploads,
  dyoffice_revision_idempotency,
  dyoffice_outbox
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  dyoffice_personal_workspaces,
  dyoffice_files,
  dyoffice_revision_files,
  dyoffice_file_revisions,
  dyoffice_edit_leases,
  dyoffice_revision_uploads,
  dyoffice_revision_idempotency,
  dyoffice_outbox
TO dyoffice_app;

GRANT SELECT (id, deployment_id, username_normalized, display_name, status, auth_version)
  ON dyoffice_users TO dyoffice_app;
GRANT SELECT ON dyoffice_user_roles TO dyoffice_app;
GRANT SELECT (id, deployment_id, user_id, expires_at, revoked_at, created_at, last_seen_at)
  ON dyoffice_sessions TO dyoffice_app;

GRANT SELECT (id, deployment_id, username_normalized, display_name, status, auth_version, password_hash, disabled_at)
  ON dyoffice_users TO dyoffice_auth;
GRANT SELECT ON dyoffice_user_roles TO dyoffice_auth;
GRANT SELECT, INSERT, UPDATE ON dyoffice_sessions TO dyoffice_auth;
GRANT SELECT, INSERT, UPDATE ON dyoffice_password_action_tokens TO dyoffice_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON dyoffice_login_rate_buckets TO dyoffice_auth;
