ALTER TABLE uploads ADD COLUMN workbook_password_protected boolean NOT NULL DEFAULT false;
ALTER TABLE uploads ADD CONSTRAINT uploads_workbook_password_protection_check
  CHECK (NOT workbook_password_protected OR format = 'xlsx');
ALTER TABLE file_revisions ADD COLUMN workbook_password_protected boolean NOT NULL DEFAULT false;
