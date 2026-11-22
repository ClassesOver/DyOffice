-- Frozen query results may now hold up to 4,000,000 canonical UTF-8 JSON bytes
-- (the SQL result budget, apps/web/server/src/modules/sources/config.ts), so
-- detail queries keep up to 10,000 moderate-width rows instead of being
-- trimmed at 1 MB. Workspace pending/saved quotas are enforced in results.ts.
ALTER TABLE workspace_source_results DROP CONSTRAINT workspace_source_results_size_bytes_check;
ALTER TABLE workspace_source_results ADD CONSTRAINT workspace_source_results_size_bytes_check
  CHECK (size_bytes BETWEEN 1 AND 4000000);
