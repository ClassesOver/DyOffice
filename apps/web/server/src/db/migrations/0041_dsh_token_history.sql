ALTER TABLE assistant_members ADD COLUMN dsh_token_issued_at timestamptz;
ALTER TABLE assistant_members ADD COLUMN dsh_token_session_id uuid;
ALTER TABLE assistant_members ADD COLUMN dsh_token_envelope text;
