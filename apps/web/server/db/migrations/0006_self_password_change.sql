-- Add a distinct self-service credential-change event. Do not rewrite 0003.
ALTER TABLE dyoffice_account_events DROP CONSTRAINT dyoffice_account_events_action_check;
ALTER TABLE dyoffice_account_events ADD CONSTRAINT dyoffice_account_events_action_check
  CHECK (action IN (
    'account.created', 'account.reset_issued', 'account.disabled', 'account.enabled',
    'password.activated', 'password.reset', 'password.changed'
  ));
