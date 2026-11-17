-- Forward-only migration after 0021. No HTTP route or UI is enabled here.
-- Terminal fencing only: never deletes bindings, uploads, objects or revisions.
ALTER TABLE command_journal DROP CONSTRAINT command_journal_state_check;
ALTER TABLE command_journal ADD CONSTRAINT command_journal_state_check
 CHECK (state IN ('pending_approval','approved','unknown_outcome','applied_uncommitted','committed','cancelled','abandoned_uncommitted'));
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE OR REPLACE FUNCTION %1$I.guard_command_journal() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
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
  IF new_state='abandoned_uncommitted' THEN
   IF NOT COALESCE(NEW.record->'envelope'->'payload'->>'toolName'='docs.replace_text.v1',false) THEN
    RAISE EXCEPTION 'Only the fixed local text command can be abandoned' USING ERRCODE='23514';
   END IF;
   IF old_state NOT IN ('pending_approval','approved','unknown_outcome','applied_uncommitted','abandoned_uncommitted')
      OR (NEW.record-'state') IS DISTINCT FROM (OLD.record-'state') THEN
    RAISE EXCEPTION 'Abandonment preserves the complete command record' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
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
 $ddl$,ns);
END $migration$;

-- Binding attempts after abandonment cannot resurrect a save path. Existing
-- binding tombstones remain intact. Take the command lock so binding/abandon
-- arbitrate in the same order as the authorized service adapter.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.guard_abandoned_command_binding() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
 DECLARE command_state text;
 BEGIN
  SELECT state INTO command_state FROM %1$I.command_journal
   WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id
     AND session_id=NEW.session_id AND command_id=NEW.command_id FOR UPDATE;
  IF command_state='abandoned_uncommitted' THEN
   RAISE EXCEPTION 'Abandoned command cannot bind a save' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION %1$I.guard_abandoned_command_binding() FROM PUBLIC;
 -- Alphabetical trigger order: command_live_file first acquires the file
 -- lifecycle lock; only then lock the command, preserving file -> command order.
 CREATE TRIGGER command_upload_abandonment BEFORE INSERT OR UPDATE ON %1$I.command_upload_bindings
 FOR EACH ROW EXECUTE FUNCTION %1$I.guard_abandoned_command_binding();
 $ddl$,ns);
END $migration$;
