-- T03b: shared, transactional login-rate limit counters.
-- Store keyed HMAC hashes of bucket identities, never usernames or IPs in clear.
CREATE TABLE dyoffice_login_rate_buckets (
  bucket_key BYTEA PRIMARY KEY CHECK (octet_length(bucket_key) = 32),
  window_started TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX dyoffice_login_rate_gc_idx ON dyoffice_login_rate_buckets (updated_at);
-- A maintenance job must eventually delete expired counters (no request-path GC).
