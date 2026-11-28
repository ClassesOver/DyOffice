ALTER TABLE workspace_file_state ADD COLUMN starred_group text,
  ADD CONSTRAINT workspace_file_state_starred_group CHECK (
    starred_group IS NULL OR (
      starred AND length(starred_group) BETWEEN 1 AND 100
      AND starred_group = btrim(starred_group) AND starred_group !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX workspace_file_state_starred_group
  ON workspace_file_state(deployment_id,owner_id,starred_group,file_id)
  WHERE starred AND starred_group IS NOT NULL;
