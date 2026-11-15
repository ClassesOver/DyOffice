-- Run with psql -v ON_ERROR_STOP=1 from repository root against disposable PostgreSQL.
-- The surrounding transaction rolls back all fixture accounts and tables.
BEGIN;
-- Isolate this fixture from any tables created by the real migration runner.
CREATE SCHEMA dyoffice_identity_constraint_test;
SET LOCAL search_path TO dyoffice_identity_constraint_test, public;
\i apps/web/server/db/migrations/0001_identity.sql
DO $$
DECLARE
  dep uuid := '11111111-1111-4111-8111-111111111111';
  another_dep uuid := '22222222-2222-4222-8222-222222222222';
  first_user uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  duplicate_user uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  bad_user uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  workspace uuid := 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  demo_hash text := '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
BEGIN
  INSERT INTO dyoffice_users(id, deployment_id, username_normalized, display_name, password_hash, status)
    VALUES(first_user,dep,'admin.local','Admin',demo_hash,'active');
  INSERT INTO dyoffice_user_roles(deployment_id,user_id,role) VALUES(dep, first_user, 'config_admin');
  INSERT INTO dyoffice_personal_workspaces(id,deployment_id,owner_user_id) VALUES(workspace,dep,first_user);
  INSERT INTO dyoffice_admin_bootstrap(deployment_id, initial_admin_user_id) VALUES(dep,first_user);

  BEGIN
    INSERT INTO dyoffice_users(id, deployment_id, username_normalized, display_name, password_hash, status)
      VALUES(duplicate_user,dep,'admin.local','Duplicate',demo_hash,'active');
    RAISE EXCEPTION 'duplicate username was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dyoffice_user_roles(deployment_id,user_id,role) VALUES(another_dep,first_user,'user');
    RAISE EXCEPTION 'cross-deployment role was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dyoffice_personal_workspaces(id,deployment_id,owner_user_id)
      VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',another_dep,first_user);
    RAISE EXCEPTION 'cross-deployment workspace was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dyoffice_admin_bootstrap(deployment_id,initial_admin_user_id) VALUES(dep,first_user);
    RAISE EXCEPTION 'duplicate bootstrap was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO dyoffice_users(id, deployment_id, username_normalized, display_name, status)
      VALUES(bad_user,dep,'notready','Invalid','active');
    RAISE EXCEPTION 'active user missing hash was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
