-- Saved query results belong to a connection, independently of the retired
-- publication history. Keep existing evidence and provenance counters intact.
DO $migration$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='workspace_source_results'::regclass
      AND confrelid='data_source_versions'::regclass AND contype='f'
  LOOP
    EXECUTE format('ALTER TABLE workspace_source_results DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $migration$;
