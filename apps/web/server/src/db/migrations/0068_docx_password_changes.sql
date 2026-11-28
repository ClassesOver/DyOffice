ALTER TABLE uploads ADD COLUMN office_password_change boolean NOT NULL DEFAULT false;
ALTER TABLE uploads ADD CONSTRAINT uploads_docx_password_change_check
  CHECK (NOT office_password_change OR (kind = 'revision' AND format = 'docx' AND restored_from IS NULL AND job_id IS NULL));
