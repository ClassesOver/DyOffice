-- DyOffice T05 file metadata. Bytes live in the object store at object_key.
-- Insert a completed row only after that object is stored.
-- Application queries must filter owner_user_id. That filter is not isolation.
-- PENDING T04: ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY on
-- dyoffice_files. This migration creates no policy and does not enable RLS.

CREATE TABLE dyoffice_files (
  id UUID PRIMARY KEY,
  deployment_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  object_key TEXT NOT NULL CHECK (object_key ~ '^blobs/[0-9a-f]{64}$'),
  sha256 CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  format VARCHAR(8) NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf')),
  name VARCHAR(255) NOT NULL CHECK (length(name) > 0 AND position('/' in name) = 0 AND position('..' in name) = 0),
  state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'trash')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trashed_at TIMESTAMPTZ,
  FOREIGN KEY (deployment_id, owner_user_id) REFERENCES dyoffice_users (deployment_id, id)
);

CREATE INDEX dyoffice_files_owner_idx ON dyoffice_files (deployment_id, owner_user_id, state);
