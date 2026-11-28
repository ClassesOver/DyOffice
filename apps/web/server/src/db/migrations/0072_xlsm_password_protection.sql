ALTER TABLE uploads DROP CONSTRAINT uploads_office_password_protection_check,
  ADD CONSTRAINT uploads_office_password_protection_check
    CHECK (NOT office_password_protected OR format IN ('docx', 'xlsx', 'xlsm'));
