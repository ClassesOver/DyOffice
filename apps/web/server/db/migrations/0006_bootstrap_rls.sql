-- Forward repair; never change the journaled 0001-0005 documents.
-- PostgreSQL roles are cluster-wide, so use this database's unique OID. A
-- second database gets a different operator role, with no shared memberships.
-- Refuse ANY pre-existing role at this identity: never adopt unknown inbound
-- members, ownership or ACLs. Reapplication is handled by the migration ledger.
DO $bootstrap_role$
DECLARE
  role_name text := 'dyoffice_bootstrap_' || (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database());
  table_name text;
BEGIN
  EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', role_name);
  -- PG16: DDL operator membership does not implicitly apply bootstrap policies.
  EXECUTE pg_catalog.format('GRANT %I TO %I WITH INHERIT FALSE', role_name, current_user);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I', role_name);
  FOREACH table_name IN ARRAY ARRAY['dyoffice_users', 'dyoffice_user_roles', 'dyoffice_personal_workspaces', 'dyoffice_admin_bootstrap']
  LOOP
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON TABLE public.%I TO %I', table_name, role_name);
    EXECUTE pg_catalog.format('CREATE POLICY %I ON public.%I FOR SELECT TO %I USING (true)', table_name || '_bootstrap_read', table_name, role_name);
    EXECUTE pg_catalog.format('CREATE POLICY %I ON public.%I FOR INSERT TO %I WITH CHECK (true)', table_name || '_bootstrap_insert', table_name, role_name);
  END LOOP;
END
$bootstrap_role$;
