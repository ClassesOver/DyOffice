ALTER TABLE files DROP CONSTRAINT files_format_check,
  ADD CONSTRAINT files_format_check CHECK (format IN ('docx','xlsx','pptx','pdf','csv'));
ALTER TABLE uploads DROP CONSTRAINT uploads_format_check,
  ADD CONSTRAINT uploads_format_check CHECK (format IN ('docx','xlsx','pptx','pdf','csv'));
