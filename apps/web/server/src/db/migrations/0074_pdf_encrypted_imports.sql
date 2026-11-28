ALTER TABLE uploads
  ADD COLUMN pdf_encrypted boolean NOT NULL DEFAULT false
  CHECK (NOT pdf_encrypted OR (format = 'pdf' AND kind = 'import'));

ALTER TABLE file_revisions
  ADD COLUMN pdf_encrypted boolean NOT NULL DEFAULT false
  CHECK (NOT pdf_encrypted OR source = 'import');
