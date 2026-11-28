ALTER TABLE uploads ADD COLUMN import_folder_id uuid,
  ADD CONSTRAINT uploads_import_folder_check CHECK (import_folder_id IS NULL OR kind = 'import');
