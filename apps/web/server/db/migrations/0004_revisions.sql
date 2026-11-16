-- T06 revision ledger, single-writer leases, idempotency, and outbox.
-- The development server commits through the file journal in
-- server/src/modules/revisions/journal.mjs, which applies the same CAS,
-- fencing, idempotency, and outbox rules in one in-process transaction.
-- This DDL is the PostgreSQL shape of that ledger. It does not enable RLS,
-- grant roles, or attach to dyoffice_users: T04 owns ownership policies.
-- Apply it with the migration runner. Do not treat this file as proof that
-- the running Web process is using PostgreSQL.

CREATE TABLE dyoffice_revision_files (
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  format VARCHAR(8) NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf')),
  current_revision TEXT NOT NULL,
  object_id UUID NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, owner_id, file_id)
);

CREATE TABLE dyoffice_file_revisions (
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  revision TEXT NOT NULL,
  parent_revision TEXT,
  object_id UUID NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  source VARCHAR(16) NOT NULL CHECK (source IN ('import', 'commit', 'restore')),
  source_command_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, owner_id, file_id, revision),
  FOREIGN KEY (deployment_id, owner_id, file_id)
    REFERENCES dyoffice_revision_files (deployment_id, owner_id, file_id)
);

CREATE TABLE dyoffice_edit_leases (
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
  session_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (deployment_id, owner_id, file_id),
  FOREIGN KEY (deployment_id, owner_id, file_id)
    REFERENCES dyoffice_revision_files (deployment_id, owner_id, file_id)
);

CREATE TABLE dyoffice_revision_uploads (
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  upload_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (upload_id),
  FOREIGN KEY (deployment_id, owner_id, file_id)
    REFERENCES dyoffice_revision_files (deployment_id, owner_id, file_id)
);

CREATE TABLE dyoffice_revision_idempotency (
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, owner_id, file_id, idempotency_key),
  FOREIGN KEY (deployment_id, owner_id, file_id, revision)
    REFERENCES dyoffice_file_revisions (deployment_id, owner_id, file_id, revision)
);

CREATE TABLE dyoffice_outbox (
  id UUID PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  file_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  revision TEXT NOT NULL,
  object_id UUID NOT NULL,
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  FOREIGN KEY (deployment_id, owner_id, file_id, revision)
    REFERENCES dyoffice_file_revisions (deployment_id, owner_id, file_id, revision)
);

CREATE INDEX dyoffice_outbox_pending_idx ON dyoffice_outbox (created_at) WHERE delivered_at IS NULL;
