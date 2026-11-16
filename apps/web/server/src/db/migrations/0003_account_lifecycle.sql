ALTER TABLE users ADD COLUMN password_reset_required boolean NOT NULL DEFAULT false;
ALTER TABLE password_action_tokens ADD COLUMN auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0);
ALTER TABLE auth_security_events ADD COLUMN subject_user_id uuid;
ALTER TABLE auth_security_events DROP CONSTRAINT auth_security_events_event_check;
ALTER TABLE auth_security_events ADD CONSTRAINT auth_security_events_event_check CHECK (event IN (
  'login_failed','login_succeeded','login_throttled','logout','session_revoked','reauthenticated',
  'admin_user_created','user_disabled','user_restored','user_roles_changed',
  'password_reset_issued','activation_reissued','password_action_consumed','password_changed'
));
CREATE INDEX password_action_owner_lookup ON password_action_tokens(deployment_id,user_id,id);
