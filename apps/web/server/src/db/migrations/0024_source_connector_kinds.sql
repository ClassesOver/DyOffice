-- Add the customer MySQL-wire connectors without rewriting 0023 or its digest.
ALTER TABLE data_source_drafts DROP CONSTRAINT data_source_drafts_kind_check;
ALTER TABLE data_source_drafts ADD CONSTRAINT data_source_drafts_kind_check CHECK (kind IN ('postgres','http','mysql','starrocks'));
ALTER TABLE data_source_versions DROP CONSTRAINT data_source_versions_kind_check;
ALTER TABLE data_source_versions ADD CONSTRAINT data_source_versions_kind_check CHECK (kind IN ('postgres','http','mysql','starrocks'));

-- A deliberate draft credential clear does not alter immutable publications.
ALTER TABLE data_source_drafts ALTER COLUMN credential_ref DROP NOT NULL;
ALTER TABLE data_source_drafts ALTER COLUMN credential_revision DROP NOT NULL;
ALTER TABLE data_source_drafts ADD CONSTRAINT data_source_draft_credential_pair CHECK ((credential_ref IS NULL) = (credential_revision IS NULL));
