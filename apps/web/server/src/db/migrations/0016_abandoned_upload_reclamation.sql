-- Forward-only. Retain upload identity/tombstones; never reuse object keys.
ALTER TABLE uploads ADD COLUMN reclaimed_at timestamptz;
ALTER TABLE uploads ADD CONSTRAINT uploads_reclaimed_shape CHECK (
  reclaimed_at IS NULL OR (state IN ('cancelled','expired') AND sha256 IS NOT NULL AND completed_file_id IS NULL)
);
CREATE INDEX uploads_reclaimable ON uploads(deployment_id,owner_id,id)
  WHERE state IN ('cancelled','expired') AND sha256 IS NOT NULL AND reclaimed_at IS NULL;
