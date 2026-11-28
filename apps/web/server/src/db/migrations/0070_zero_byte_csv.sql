ALTER TABLE uploads DROP CONSTRAINT uploads_expected_size_check,
  ADD CONSTRAINT uploads_expected_size_check
    CHECK (expected_size BETWEEN 0 AND 33554432 AND (expected_size > 0 OR format = 'csv'));
ALTER TABLE file_revisions DROP CONSTRAINT file_revisions_size_check,
  ADD CONSTRAINT file_revisions_size_check CHECK (size BETWEEN 0 AND 33554432);
