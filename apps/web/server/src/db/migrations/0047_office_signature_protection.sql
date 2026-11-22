-- NULL identifies pre-existing rows whose immutable bytes need inspection.
ALTER TABLE file_revisions ADD COLUMN office_signature_protected boolean;
ALTER TABLE uploads ADD COLUMN office_signature_protected boolean;
