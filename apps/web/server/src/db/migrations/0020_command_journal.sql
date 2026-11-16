-- Depends on 0018/0019; forward-only. No route is enabled by this migration.
CREATE TABLE command_journal (
 deployment_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 session_id uuid NOT NULL,
 command_id uuid NOT NULL,
 file_id uuid NOT NULL,
 record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
 state text GENERATED ALWAYS AS (record->>'state') STORED NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(deployment_id,owner_id,session_id,command_id),
 UNIQUE(deployment_id,owner_id,session_id,command_id,file_id),
 FOREIGN KEY(deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id),
 FOREIGN KEY(deployment_id,owner_id,file_id) REFERENCES files(deployment_id,owner_id,id),
 CHECK (state IN ('pending_approval','approved','unknown_outcome','applied_uncommitted','committed','cancelled')),
 CHECK ((jsonb_typeof(record->'envelope')='object' AND record->'envelope'->>'commandId'=command_id::text AND record->'envelope'->>'fileId'=file_id::text) IS TRUE),
 CHECK ((jsonb_typeof(record->'digest')='string' AND record->>'digest' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(record->'policyHash')='string' AND record->>'policyHash' ~ '^[a-f0-9]{64}$') IS TRUE),
 CHECK ((record->'envelope'->>'argsHash' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(record->'envelope'->'payload')='object' AND jsonb_typeof(record->'envelope'->'payload'->'arguments')='object' AND jsonb_typeof(record->'envelope'->'payload'->'toolName')='string' AND record->'envelope'->>'baseRevision' ~ '^[a-f0-9-]{36}$' AND jsonb_typeof(record->'envelope'->'leaseEpoch')='number' AND record->'envelope'->>'leaseEpoch' ~ '^[1-9][0-9]*$' AND jsonb_typeof(record->'envelope'->'editorGeneration')='number' AND record->'envelope'->>'editorGeneration' ~ '^(0|[1-9][0-9]*)$') IS TRUE)
);
CREATE TABLE command_upload_bindings (
 deployment_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 session_id uuid NOT NULL,
 command_id uuid NOT NULL,
 file_id uuid NOT NULL,
 upload_id uuid NOT NULL,
 editor_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 size integer NOT NULL CHECK (size BETWEEN 1 AND 33554432),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(deployment_id,owner_id,session_id,command_id),
 UNIQUE(deployment_id,owner_id,file_id,upload_id),
 FOREIGN KEY(deployment_id,owner_id,session_id,command_id,file_id) REFERENCES command_journal(deployment_id,owner_id,session_id,command_id,file_id),
 FOREIGN KEY(deployment_id,owner_id,file_id,upload_id) REFERENCES uploads(deployment_id,owner_id,file_id,id)
);
DO $migration$
DECLARE ns text:=current_schema(); relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['command_journal','command_upload_bindings'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  EXECUTE format($policy$CREATE POLICY own_session_command ON %I USING (
    deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
    AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
    AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid
   ) WITH CHECK (
    deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid
    AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
    AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid
   )$policy$,relation);
  EXECUTE format('CREATE TRIGGER command_live_file BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.guard_file_lifecycle()',ns,relation,ns);
 END LOOP;
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.guard_command_journal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
 DECLARE old_state text; new_state text;
 BEGIN
  new_state:=NEW.record->>'state';
  IF (NEW.record-ARRAY['envelope','digest','policyHash','state','approvedUntil','claimId','operation','appliedGeneration','revision'])<>'{}'::jsonb THEN
   RAISE EXCEPTION 'Unknown command fields' USING ERRCODE='23514';
  END IF;
  IF NEW.record ? 'approvedUntil' AND NOT COALESCE(jsonb_typeof(NEW.record->'approvedUntil')='number' AND NEW.record->>'approvedUntil' ~ '^[1-9][0-9]*$',false) THEN
   RAISE EXCEPTION 'Invalid approval deadline' USING ERRCODE='23514';
  END IF;
  IF new_state IN ('approved','unknown_outcome','applied_uncommitted','committed') AND NOT (NEW.record ? 'approvedUntil') THEN
   RAISE EXCEPTION 'Approval deadline required' USING ERRCODE='23514';
  END IF;
  IF NEW.record ? 'claimId' AND NOT COALESCE(jsonb_typeof(NEW.record->'claimId')='string' AND NEW.record->>'claimId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN
   RAISE EXCEPTION 'Invalid claim identity' USING ERRCODE='23514';
  END IF;
  IF new_state IN ('unknown_outcome','applied_uncommitted','committed') AND NOT COALESCE(NEW.record ? 'claimId' AND NEW.record->>'operation' IN ('apply','undo'),false) THEN
   RAISE EXCEPTION 'Claim identity and operation required' USING ERRCODE='23514';
  END IF;
  IF NEW.record ? 'appliedGeneration' AND NOT COALESCE(jsonb_typeof(NEW.record->'appliedGeneration')='number' AND NEW.record->>'appliedGeneration' ~ '^(0|[1-9][0-9]*)$',false) THEN
   RAISE EXCEPTION 'Invalid applied generation' USING ERRCODE='23514';
  END IF;
  IF new_state IN ('applied_uncommitted','committed') AND NOT COALESCE(NEW.record ? 'appliedGeneration' AND NEW.record->>'operation'='apply',false) THEN
   RAISE EXCEPTION 'Applied generation required' USING ERRCODE='23514';
  END IF;
  IF new_state IN ('pending_approval','approved') AND NEW.record ?| ARRAY['claimId','operation','appliedGeneration','revision'] THEN
   RAISE EXCEPTION 'Unexecuted command has receipt fields' USING ERRCODE='23514';
  END IF;
  IF new_state='committed' AND NOT COALESCE(jsonb_typeof(NEW.record->'revision')='object' AND NEW.record->'revision'->>'fileId'=NEW.file_id::text AND NEW.record->'revision'->>'revision' ~ '^[a-f0-9-]{36}$' AND NEW.record->'revision'->>'sha256' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(NEW.record->'revision'->'size')='number' AND NEW.record->'revision'->>'size' ~ '^[1-9][0-9]*$',false) THEN
   RAISE EXCEPTION 'Invalid committed revision' USING ERRCODE='23514';
  END IF;
  IF (new_state='committed') IS DISTINCT FROM (NEW.record ? 'revision') THEN
   RAISE EXCEPTION 'Revision only belongs to a committed command' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
   IF new_state IS DISTINCT FROM 'pending_approval' THEN RAISE EXCEPTION 'Command must begin with approval' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END IF;
  old_state:=OLD.record->>'state';
  IF (NEW.deployment_id,NEW.owner_id,NEW.session_id,NEW.command_id,NEW.file_id,NEW.created_at) IS DISTINCT FROM
     (OLD.deployment_id,OLD.owner_id,OLD.session_id,OLD.command_id,OLD.file_id,OLD.created_at)
    OR (NEW.record-ARRAY['state','claimId','operation','appliedGeneration','revision','approvedUntil']) IS DISTINCT FROM
       (OLD.record-ARRAY['state','claimId','operation','appliedGeneration','revision','approvedUntil']) THEN
   RAISE EXCEPTION 'Command identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.record=OLD.record THEN RETURN NEW; END IF;
  IF NOT ((old_state='pending_approval' AND new_state IN ('approved','cancelled'))
    OR (old_state='approved' AND new_state IN ('unknown_outcome','cancelled'))
    OR (old_state='unknown_outcome' AND OLD.record->>'operation'='apply' AND new_state IN ('applied_uncommitted','committed'))
    OR (old_state='unknown_outcome' AND OLD.record->>'operation'='undo' AND new_state='cancelled')
    OR (old_state='applied_uncommitted' AND new_state IN ('unknown_outcome','committed'))) THEN
   RAISE EXCEPTION 'Command transition is irreversible' USING ERRCODE='23514';
  END IF;
  IF new_state='unknown_outcome' AND (
    NEW.record->>'operation' IS DISTINCT FROM CASE WHEN old_state='approved' THEN 'apply' ELSE 'undo' END
    OR NOT COALESCE(NEW.record->>'claimId' ~ '^[a-f0-9-]{36}$',false)) THEN
   RAISE EXCEPTION 'Invalid command claim' USING ERRCODE='23514';
  END IF;
  IF new_state<>'unknown_outcome' AND (NEW.record->'claimId',NEW.record->'operation') IS DISTINCT FROM (OLD.record->'claimId',OLD.record->'operation') THEN
   RAISE EXCEPTION 'Claim receipt cannot be rebound' USING ERRCODE='23514';
  END IF;
  IF old_state='approved' AND new_state='unknown_outcome' AND (OLD.record->>'approvedUntil')::numeric<=extract(epoch from clock_timestamp())*1000 THEN
   RAISE EXCEPTION 'Command approval expired' USING ERRCODE='23514';
  END IF;
  IF OLD.record ? 'appliedGeneration' AND NEW.record->'appliedGeneration' IS DISTINCT FROM OLD.record->'appliedGeneration' THEN
   RAISE EXCEPTION 'Applied generation cannot be rebound' USING ERRCODE='23514';
  END IF;
  IF old_state<>'pending_approval' AND NEW.record->'approvedUntil' IS DISTINCT FROM OLD.record->'approvedUntil' THEN
   RAISE EXCEPTION 'Approval cannot be extended' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION %1$I.guard_command_journal() FROM PUBLIC;
 CREATE TRIGGER command_journal_state BEFORE INSERT OR UPDATE ON %1$I.command_journal FOR EACH ROW EXECUTE FUNCTION %1$I.guard_command_journal();
 $ddl$,ns);
END $migration$;

-- A sourceCommandId label alone is not provenance. Known session commands must
-- have an immutable upload binding, and commit atomically fences undo in the
-- SAME T06 transaction. Legacy unknown source labels retain their old semantics.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.commit_bound_command() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
 DECLARE cmd %1$I.command_journal; bound %1$I.command_upload_bindings; upload %1$I.uploads; revision %1$I.file_revisions;
 BEGIN
  SELECT * INTO bound FROM %1$I.command_upload_bindings WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id AND file_id=NEW.file_id
   AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid AND upload_id=NEW.upload_id;
  IF FOUND AND NEW.requested_source_command_id IS DISTINCT FROM bound.command_id THEN
   RAISE EXCEPTION 'Bound upload requires its command identity' USING ERRCODE='23514',CONSTRAINT='command_revision_guard';
  END IF;
  IF NEW.requested_source_command_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO cmd FROM %1$I.command_journal WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id
   AND session_id=NULLIF(current_setting('dyoffice.session_id',true),'')::uuid AND command_id=NEW.requested_source_command_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO bound FROM %1$I.command_upload_bindings WHERE deployment_id=cmd.deployment_id AND owner_id=cmd.owner_id AND session_id=cmd.session_id AND command_id=cmd.command_id;
  SELECT * INTO upload FROM %1$I.uploads WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id AND file_id=NEW.file_id AND id=NEW.upload_id;
  SELECT * INTO revision FROM %1$I.file_revisions WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id AND file_id=NEW.file_id AND id=NEW.revision_id;
  IF NOT COALESCE(cmd.state='applied_uncommitted' AND cmd.record->>'operation'='apply' AND cmd.file_id=NEW.file_id
    AND bound.upload_id=NEW.upload_id AND bound.idempotency_key=NEW.idempotency_key
    AND cmd.record->'envelope'->>'baseRevision'=NEW.base_revision::text AND (cmd.record->'envelope'->>'leaseEpoch')::bigint=NEW.lease_epoch
    AND NEW.job_id IS NULL AND upload.session_id=cmd.session_id AND upload.state='committed' AND upload.base_revision=NEW.base_revision AND upload.lease_epoch=NEW.lease_epoch
    AND upload.editor_id=bound.editor_id AND upload.sha256=bound.sha256 AND upload.expected_size=bound.size
    AND revision.sha256=bound.sha256 AND revision.size=bound.size AND revision.parent_revision=NEW.base_revision AND revision.source='save',false) THEN
   RAISE EXCEPTION 'Command save intent is not current' USING ERRCODE='23514',CONSTRAINT='command_revision_guard';
  END IF;
  UPDATE %1$I.command_journal SET record=record||jsonb_build_object('state','committed','revision',jsonb_build_object('fileId',NEW.file_id,'revision',NEW.revision_id,'sha256',revision.sha256,'size',revision.size)),updated_at=clock_timestamp()
   WHERE deployment_id=cmd.deployment_id AND owner_id=cmd.owner_id AND session_id=cmd.session_id AND command_id=cmd.command_id;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION %1$I.commit_bound_command() FROM PUBLIC;
 CREATE TRIGGER command_revision_guard BEFORE INSERT ON %1$I.revision_commits FOR EACH ROW EXECUTE FUNCTION %1$I.commit_bound_command();
 $ddl$,ns);
END $migration$;
