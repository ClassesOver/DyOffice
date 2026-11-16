ALTER TABLE revision_outbox ADD COLUMN delivery_epoch bigint NOT NULL DEFAULT 0 CHECK(delivery_epoch BETWEEN 0 AND 9007199254740991),
 ADD COLUMN delivery_hash text CHECK(delivery_hash ~ '^[a-f0-9]{64}$'),
 ADD COLUMN delivery_until timestamptz,
 ADD COLUMN next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD CHECK((delivery_hash IS NULL)=(delivery_until IS NULL));
CREATE INDEX revision_outbox_due ON revision_outbox(deployment_id,next_delivery_at,id);
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format('CREATE POLICY internal_revision_delivery ON %I.revision_outbox TO %I USING(true) WITH CHECK(true)',ns,current_user);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.take_revision_delivery(p_deployment uuid,p_hash text,p_ms integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 DECLARE event %1$I.revision_outbox;
 BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_ms IS NULL OR p_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
  SELECT * INTO event FROM %1$I.revision_outbox WHERE deployment_id=p_deployment AND next_delivery_at<=clock_timestamp()
   AND (delivery_until IS NULL OR delivery_until<=clock_timestamp()) AND delivery_epoch<9007199254740991
   ORDER BY next_delivery_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE %1$I.revision_outbox SET delivery_epoch=delivery_epoch+1,delivery_hash=p_hash,delivery_until=clock_timestamp()+p_ms*interval '1 millisecond'
   WHERE id=event.id RETURNING * INTO event;
  RETURN jsonb_build_object('eventId',event.id,'deliveryEpoch',event.delivery_epoch);
 END $function$;
 CREATE FUNCTION %1$I.ack_revision_delivery(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_ms integer) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
 BEGIN
  IF p_ms IS NULL OR p_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
  UPDATE %1$I.revision_outbox SET delivery_hash=NULL,delivery_until=NULL,published_at=clock_timestamp(),next_delivery_at=clock_timestamp()+p_ms*interval '1 millisecond'
   WHERE deployment_id=p_deployment AND id=p_id AND delivery_epoch=p_epoch AND delivery_hash=p_hash AND delivery_until>clock_timestamp();
  RETURN FOUND;
 END $function$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.take_revision_delivery(uuid,text,integer),%I.ack_revision_delivery(uuid,uuid,bigint,text,integer) FROM PUBLIC',ns,ns);
END $migration$;
