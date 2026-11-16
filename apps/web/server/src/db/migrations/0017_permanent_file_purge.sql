ALTER TABLE files ADD COLUMN purge_started_at timestamptz, ADD COLUMN purged_at timestamptz,
 ADD CHECK (purge_started_at IS NULL OR deleted_at IS NOT NULL),
 ADD CHECK (purged_at IS NULL OR purge_started_at IS NOT NULL);
ALTER TABLE file_revisions ADD COLUMN reclaimed_at timestamptz;
ALTER TABLE revision_outbox ADD COLUMN retired_at timestamptz;

-- Tombstones preserve all identity/receipt/provenance foreign keys. They are no
-- longer live content references; neither new references nor restoration may
-- cross the committed purge fence.
DO $migration$
DECLARE ns text:=current_schema(); relation text;
BEGIN
 EXECUTE format('CREATE POLICY internal_file_lifecycle ON %I.files TO %I USING(true) WITH CHECK(true)',ns,current_user);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.guard_file_lifecycle() RETURNS trigger
 LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
 DECLARE retiring boolean;
 BEGIN
  IF TG_TABLE_NAME='files' THEN
   IF OLD.purge_started_at IS NOT NULL AND (
    NEW.purge_started_at IS DISTINCT FROM OLD.purge_started_at OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.current_revision IS DISTINCT FROM OLD.current_revision OR (OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at)) THEN
     RAISE EXCEPTION 'File is permanently retired' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
  END IF;
  -- Delivery updates hold only the outbox lock; never invert purge's file -> outbox order.
  IF TG_TABLE_NAME='revision_outbox' AND TG_OP='UPDATE' THEN
   IF (to_jsonb(NEW)-ARRAY['retired_at','delivery_epoch','delivery_hash','delivery_until','published_at','next_delivery_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['retired_at','delivery_epoch','delivery_hash','delivery_until','published_at','next_delivery_at'])
      OR (OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at OR NEW.delivery_hash IS NOT NULL OR NEW.delivery_until IS NOT NULL)) THEN
    RAISE EXCEPTION 'Retired event cannot be revived or rebound' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='edit_leases' AND TG_OP='UPDATE' THEN
   IF NEW.expires_at<=clock_timestamp() THEN RETURN NEW; END IF;
  END IF;
  -- Active jobs already prevent purge admission. Do not add a job -> file
  -- lock edge for ordinary deadline/claim updates or same-identity termination.
  IF TG_TABLE_NAME='native_jobs' AND TG_OP='UPDATE' THEN
   IF (NEW.deployment_id,NEW.owner_id,NEW.id,NEW.file_id,NEW.artifact_id,NEW.result_revision)
     IS NOT DISTINCT FROM (OLD.deployment_id,OLD.owner_id,OLD.id,OLD.file_id,OLD.artifact_id,OLD.result_revision)
     AND (OLD.state IN ('queued','running') OR NEW.state NOT IN ('queued','running')) THEN RETURN NEW; END IF;
  END IF;
  SELECT purge_started_at IS NOT NULL INTO retiring FROM %1$I.files
   WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id AND id=NEW.file_id FOR SHARE;
  IF retiring THEN
   IF TG_TABLE_NAME='file_revisions' AND TG_OP='UPDATE' THEN
    IF OLD.reclaimed_at IS NOT NULL AND NEW.reclaimed_at IS DISTINCT FROM OLD.reclaimed_at THEN
     RAISE EXCEPTION 'Reclamation is irreversible' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
   END IF;
   IF TG_TABLE_NAME='uploads' AND TG_OP='UPDATE' THEN
    IF NEW.state IN ('cancelled','expired','committed') AND
      (to_jsonb(NEW)-ARRAY['state','reclaimed_at']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reclaimed_at']) THEN RETURN NEW; END IF;
   END IF;

   IF TG_TABLE_NAME='native_jobs' AND TG_OP='UPDATE' THEN
    IF NEW.state NOT IN ('queued','running') AND
      (to_jsonb(NEW)-ARRAY['state','finished_at','error_code','claim_epoch','claim_hash','lease_until']) IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['state','finished_at','error_code','claim_epoch','claim_hash','lease_until']) THEN RETURN NEW; END IF;
   END IF;
   RAISE EXCEPTION 'File is permanently retired' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='file_revisions' AND TG_OP='UPDATE' THEN
   IF NEW.reclaimed_at IS NOT NULL THEN RAISE EXCEPTION 'Live revision cannot be reclaimed' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION %1$I.guard_file_lifecycle() FROM PUBLIC;
 CREATE TRIGGER file_lifecycle_guard BEFORE UPDATE ON %1$I.files FOR EACH ROW EXECUTE FUNCTION %1$I.guard_file_lifecycle();
 $ddl$,ns);
 FOREACH relation IN ARRAY ARRAY['file_revisions','uploads','edit_leases','native_jobs','revision_commits','revision_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER file_reference_guard BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.guard_file_lifecycle()',ns,relation,ns);
 END LOOP;
END $migration$;

DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE OR REPLACE FUNCTION %1$I.take_revision_delivery(p_deployment uuid,p_hash text,p_ms integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 DECLARE event %1$I.revision_outbox;
 BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_ms IS NULL OR p_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
  SELECT * INTO event FROM %1$I.revision_outbox WHERE retired_at IS NULL AND deployment_id=p_deployment AND next_delivery_at<=clock_timestamp()
   AND (delivery_until IS NULL OR delivery_until<=clock_timestamp()) AND delivery_epoch<9007199254740991
   ORDER BY next_delivery_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE %1$I.revision_outbox SET delivery_epoch=delivery_epoch+1,delivery_hash=p_hash,delivery_until=clock_timestamp()+p_ms*interval '1 millisecond'
   WHERE id=event.id RETURNING * INTO event;
  RETURN jsonb_build_object('eventId',event.id,'deliveryEpoch',event.delivery_epoch);
 END $function$;
 CREATE OR REPLACE FUNCTION %1$I.ack_revision_delivery(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_ms integer) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 BEGIN
  IF p_ms IS NULL OR p_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
  -- Preserve migration 0015: evaluate expiry only after acquiring the row lock.
  PERFORM 1 FROM %1$I.revision_outbox WHERE deployment_id=p_deployment AND id=p_id FOR UPDATE;
  UPDATE %1$I.revision_outbox SET delivery_hash=NULL,delivery_until=NULL,published_at=clock_timestamp(),next_delivery_at=clock_timestamp()+p_ms*interval '1 millisecond'
   WHERE retired_at IS NULL AND deployment_id=p_deployment AND id=p_id AND delivery_epoch=p_epoch AND delivery_hash=p_hash AND delivery_until>clock_timestamp();
  RETURN FOUND;
 END $function$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.take_revision_delivery(uuid,text,integer),%I.ack_revision_delivery(uuid,uuid,bigint,text,integer) FROM PUBLIC',ns,ns);
END $migration$;
