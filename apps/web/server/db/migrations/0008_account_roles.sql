-- Record an explicit role change. Do not rewrite earlier account-event migrations.
ALTER TABLE dyoffice_account_events DROP CONSTRAINT dyoffice_account_events_action_check;
ALTER TABLE dyoffice_account_events ADD CONSTRAINT dyoffice_account_events_action_check
  CHECK (action IN (
    'account.created', 'account.reset_issued', 'account.disabled', 'account.enabled',
    'account.role_changed',
    'password.activated', 'password.reset', 'password.changed'
  ));
-- Role rows stay in dyoffice_user_roles. This migration does not grant file access
-- and does not enable row-level security.
