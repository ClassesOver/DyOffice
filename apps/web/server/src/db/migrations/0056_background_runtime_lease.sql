-- Move existing lease deadlines without changing any claim identity or credential.
UPDATE task_runtime_channel t SET lease_until=q.lease_until FROM task_background_claims q
 WHERE t.task_id=q.task_id AND q.lease_until IS NOT NULL;
CREATE OR REPLACE VIEW assistant_background_queue WITH (security_invoker=true) AS
 SELECT q.task_id,q.deployment_id,q.owner_id,q.conversation_id,q.credential,q.claim_id,q.claim_hash,
        t.lease_until,q.created_at
 FROM task_background_claims q JOIN task_runtime_channel t USING(deployment_id,owner_id,conversation_id,task_id);

CREATE OR REPLACE VIEW task_runtime_status WITH (security_invoker = true) AS
 SELECT 'codex'::text AS executor, r.deployment_id, r.owner_id, r.file_id,
        r.session_id, NULL::uuid AS conversation_id, r.turn_id AS task_id,
        r.state AS stored_state,
        CASE WHEN r.state IN ('running','cancel_requested') AND r.lease_until<=clock_timestamp()
             THEN 'unknown_outcome' ELSE r.state END AS state,
        r.cancel_requested,
        r.lease_until, r.expires_at, r.renewed_at
 FROM task_runtime_codex r
 UNION ALL
 SELECT CASE WHEN t.execution='saved-revision' THEN 'background' ELSE 'channel' END,
        t.deployment_id, t.owner_id, ch.file_id, NULL::uuid, t.conversation_id,
        t.task_id::text, t.state, t.state, t.cancel_requested, t.lease_until, NULL::timestamptz, t.renewed_at
 FROM task_runtime_channel t
 JOIN assistant_channels ch USING(deployment_id,owner_id,conversation_id);

ALTER TABLE task_background_claims DROP COLUMN lease_until;

DO $migration$
BEGIN
 EXECUTE format($ddl$
 CREATE OR REPLACE FUNCTION %1$I.take_assistant_background(p_deployment uuid,p_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE q %1$I.assistant_background_queue;
 BEGIN
  IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid claim'; END IF;
  SELECT pending.* INTO q FROM %1$I.assistant_background_queue pending
   WHERE pending.deployment_id=p_deployment AND pending.credential IS NOT NULL AND (pending.claim_id IS NULL OR pending.lease_until<clock_timestamp())
    AND (pending.claim_id IS NOT NULL OR (
     NOT EXISTS(SELECT 1 FROM %1$I.assistant_tasks active WHERE active.deployment_id=pending.deployment_id AND active.owner_id=pending.owner_id AND active.conversation_id=pending.conversation_id AND active.recipient='office' AND active.state IN ('running','cancel_requested') AND active.deadline_at>clock_timestamp())
     AND NOT EXISTS(SELECT 1 FROM %1$I.assistant_background_queue leased WHERE leased.deployment_id=pending.deployment_id AND leased.owner_id=pending.owner_id AND leased.conversation_id=pending.conversation_id AND leased.task_id<>pending.task_id AND leased.credential IS NOT NULL AND leased.claim_id IS NOT NULL AND leased.lease_until>=clock_timestamp())
    ))
   ORDER BY pending.created_at,pending.task_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE %1$I.task_runtime_channel SET lease_until=clock_timestamp()+interval '30 seconds',renewed_at=clock_timestamp()
   WHERE task_id=q.task_id;
  IF q.claim_id IS NOT NULL THEN
   UPDATE %1$I.task_background_claims SET claim_hash=p_hash WHERE task_id=q.task_id;
   RETURN jsonb_build_object('taskId',q.task_id,'conversationId',q.conversation_id,'credential',q.credential,'claimId',q.claim_id,'expired',true);
  END IF;
  UPDATE %1$I.task_background_claims SET claim_id=gen_random_uuid(),claim_hash=p_hash
   WHERE task_id=q.task_id RETURNING claim_id INTO q.claim_id;
  RETURN jsonb_build_object('taskId',q.task_id,'conversationId',q.conversation_id,'credential',q.credential,'claimId',q.claim_id,'expired',false);
 END $fn$;
 CREATE OR REPLACE FUNCTION %1$I.abandon_assistant_background(p_deployment uuid,p_task uuid,p_claim uuid,p_hash text) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE q %1$I.assistant_background_queue; t %1$I.assistant_tasks; parent %1$I.assistant_tasks; seq bigint; next_state text;
 BEGIN
  SELECT * INTO q FROM %1$I.assistant_background_queue WHERE deployment_id=p_deployment AND task_id=p_task;
  IF NOT FOUND OR q.claim_id IS DISTINCT FROM p_claim OR (q.claim_hash IS DISTINCT FROM p_hash AND (q.credential IS NOT NULL OR q.lease_until>=clock_timestamp())) THEN RETURN false; END IF;
  PERFORM 1 FROM %1$I.assistant_channels WHERE deployment_id=q.deployment_id AND owner_id=q.owner_id AND conversation_id=q.conversation_id FOR UPDATE;
  SELECT * INTO q FROM %1$I.assistant_background_queue WHERE task_id=p_task FOR UPDATE;
  IF q.claim_id IS DISTINCT FROM p_claim OR (q.claim_hash IS DISTINCT FROM p_hash AND (q.credential IS NOT NULL OR q.lease_until>=clock_timestamp())) THEN RETURN false; END IF;
  SELECT * INTO t FROM %1$I.assistant_tasks WHERE task_id=p_task FOR UPDATE;
  IF t.state IN ('queued','running','waiting_peer','cancel_requested') THEN
   next_state:=CASE WHEN t.state='queued' OR t.cancel_requested THEN 'cancelled' ELSE 'unknown_outcome' END;
   UPDATE %1$I.task_runtime_channel SET state=next_state WHERE task_id=p_task AND state=t.state;
   UPDATE %1$I.assistant_channels SET sequence=sequence+1 WHERE conversation_id=q.conversation_id RETURNING sequence INTO seq;
   INSERT INTO %1$I.assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,task_id,audience,type,payload)
    VALUES(gen_random_uuid(),q.deployment_id,q.owner_id,q.conversation_id,seq,p_task,t.sender,'task',jsonb_build_object('taskId',p_task,'state',next_state));
  END IF;
  IF t.parent_task_id IS NOT NULL THEN
   SELECT * INTO parent FROM %1$I.assistant_tasks WHERE task_id=t.parent_task_id AND deployment_id=q.deployment_id AND owner_id=q.owner_id AND conversation_id=q.conversation_id FOR UPDATE;
   IF parent.state='waiting_peer' AND jsonb_array_length(parent.child_task_ids)>0
    AND jsonb_array_length(parent.child_task_ids)=(SELECT count(*) FROM %1$I.assistant_tasks WHERE task_id IN (SELECT value::uuid FROM jsonb_array_elements_text(parent.child_task_ids)) AND deployment_id=q.deployment_id AND owner_id=q.owner_id AND conversation_id=q.conversation_id AND state IN ('succeeded','failed','cancelled')) THEN
    UPDATE %1$I.task_runtime_channel SET state='queued' WHERE task_id=parent.task_id AND state='waiting_peer';
    UPDATE %1$I.assistant_channels SET sequence=sequence+1 WHERE conversation_id=q.conversation_id RETURNING sequence INTO seq;
    INSERT INTO %1$I.assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,task_id,audience,type,payload)
     VALUES(gen_random_uuid(),q.deployment_id,q.owner_id,q.conversation_id,seq,parent.task_id,parent.recipient,'task',jsonb_build_object('taskId',parent.task_id,'state','queued'));
   END IF;
  END IF;
  UPDATE %1$I.task_background_claims SET credential=NULL,claim_hash=NULL WHERE task_id=p_task;
  UPDATE %1$I.task_runtime_channel SET lease_until=NULL WHERE task_id=p_task;
  RETURN true;
 END $fn$;
 $ddl$,current_schema());
END $migration$;
