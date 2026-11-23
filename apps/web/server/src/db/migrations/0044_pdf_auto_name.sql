ALTER TABLE files ADD COLUMN pdf_auto_name_pending boolean NOT NULL DEFAULT false
  CHECK (NOT pdf_auto_name_pending OR format = 'pdf');
ALTER TABLE uploads ADD COLUMN pdf_auto_name text
  CHECK (pdf_auto_name IS NULL OR (kind = 'revision' AND format = 'pdf' AND octet_length(pdf_auto_name) BETWEEN 5 AND 255));
