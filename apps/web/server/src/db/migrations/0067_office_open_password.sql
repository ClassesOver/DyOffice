ALTER TABLE uploads DROP CONSTRAINT uploads_workbook_password_protection_check;
ALTER TABLE uploads RENAME COLUMN workbook_password_protected TO office_password_protected;
ALTER TABLE uploads ADD CONSTRAINT uploads_office_password_protection_check
  CHECK (NOT office_password_protected OR format IN ('docx', 'xlsx'));
ALTER TABLE file_revisions RENAME COLUMN workbook_password_protected TO office_password_protected;
