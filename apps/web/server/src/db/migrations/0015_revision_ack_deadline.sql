-- Forward-only repair: lock waits must not extend a revision delivery capability.
-- CREATE OR REPLACE retains the existing owner and worker EXECUTE grant.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE OR REPLACE FUNCTION %1$I.ack_revision_delivery(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_ms integer) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 BEGIN
  IF p_ms IS NULL OR p_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
  PERFORM 1 FROM %1$I.revision_outbox WHERE deployment_id=p_deployment AND id=p_id FOR UPDATE;
  UPDATE %1$I.revision_outbox SET delivery_hash=NULL,delivery_until=NULL,published_at=clock_timestamp(),next_delivery_at=clock_timestamp()+p_ms*interval '1 millisecond'
   WHERE deployment_id=p_deployment AND id=p_id AND delivery_epoch=p_epoch AND delivery_hash=p_hash AND delivery_until>clock_timestamp();
  RETURN FOUND;
 END $function$;
 $ddl$,ns);
END $migration$;
