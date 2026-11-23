-- Existing results have no reliable document provenance and stay in Home.
ALTER TABLE workspace_source_results ADD COLUMN document_id uuid,
  ADD FOREIGN KEY (deployment_id,owner_id,document_id)
  REFERENCES files(deployment_id,owner_id,id) ON DELETE CASCADE;
CREATE INDEX workspace_source_results_document_saved
  ON workspace_source_results(deployment_id,owner_id,workspace_id,document_id,result_id)
  WHERE state='saved';

-- 0028 created the workspace-wide receipt constraint with a generated name.
DO $$
DECLARE receipt_constraint name;
BEGIN
  SELECT conname INTO STRICT receipt_constraint FROM pg_constraint
    WHERE conrelid='workspace_source_results'::regclass AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (deployment_id, owner_id, workspace_id, save_command_id)';
  EXECUTE format('ALTER TABLE workspace_source_results DROP CONSTRAINT %I',receipt_constraint);
END $$;
CREATE UNIQUE INDEX workspace_source_results_document_receipt
  ON workspace_source_results(deployment_id,owner_id,workspace_id,document_id,save_command_id)
  WHERE document_id IS NOT NULL AND save_command_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_source_results_home_receipt
  ON workspace_source_results(deployment_id,owner_id,workspace_id,save_command_id)
  WHERE document_id IS NULL AND save_command_id IS NOT NULL;
