-- T03c: explicit action-token revocation and transactional, secret-free account events.
-- This is a new migration; existing 0001/0002 migration bytes must remain immutable.
ALTER TABLE dyoffice_password_action_tokens ADD COLUMN revoked_at TIMESTAMPTZ;
CREATE INDEX dyoffice_password_actions_live_idx
  ON dyoffice_password_action_tokens (deployment_id, user_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE dyoffice_account_events (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  target_user_id UUID NOT NULL,
  action VARCHAR(32) NOT NULL CHECK (action IN (
    'account.created', 'account.reset_issued', 'account.disabled', 'account.enabled',
    'password.activated', 'password.reset'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (deployment_id, actor_user_id) REFERENCES dyoffice_users (deployment_id, id),
  FOREIGN KEY (deployment_id, target_user_id) REFERENCES dyoffice_users (deployment_id, id)
);
CREATE INDEX dyoffice_account_events_target_idx
  ON dyoffice_account_events (deployment_id, target_user_id, created_at);
-- Runtime role grants, audit retention, and FORCE RLS are T04 gates. No production
-- route is enabled by this migration. Passwords, token plaintext and arbitrary
-- client metadata have no columns here and must not be added to event payloads.
