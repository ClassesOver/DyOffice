ALTER TABLE assistant_channels ALTER COLUMN file_id DROP NOT NULL;
ALTER TABLE assistant_channels ADD COLUMN background_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE assistant_tasks ADD COLUMN execution text CHECK (execution IS NULL OR execution='saved-revision');
ALTER TABLE assistant_tasks ADD COLUMN saved_revision uuid;
ALTER TABLE assistant_tasks ADD COLUMN saved_sha256 text;
ALTER TABLE assistant_tasks ADD COLUMN saved_size bigint;
CREATE TABLE assistant_background_queue (
 task_id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, conversation_id uuid NOT NULL,
 credential text, claim_id uuid, claim_hash text, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (deployment_id,owner_id,conversation_id) REFERENCES assistant_channels(deployment_id,owner_id,conversation_id),
 FOREIGN KEY (task_id) REFERENCES assistant_tasks(task_id)
);
CREATE INDEX assistant_background_pending ON assistant_background_queue(deployment_id,created_at) WHERE credential IS NOT NULL;
ALTER TABLE assistant_background_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_background_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY own_background ON assistant_background_queue USING (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
 deployment_id=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid AND owner_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid
);
REVOKE ALL ON assistant_background_queue FROM PUBLIC;
DO $migration$
BEGIN
 EXECUTE format('CREATE POLICY schedule_background ON assistant_background_queue TO %I USING(true) WITH CHECK(true)',current_user);
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.take_assistant_background(p_deployment uuid,p_hash text) RETURNS jsonb
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
  IF q.claim_id IS NOT NULL THEN
   UPDATE %1$I.assistant_background_queue SET claim_hash=p_hash,lease_until=clock_timestamp()+interval '30 seconds' WHERE task_id=q.task_id;
   RETURN jsonb_build_object('taskId',q.task_id,'conversationId',q.conversation_id,'credential',q.credential,'claimId',q.claim_id,'expired',true);
  END IF;
  UPDATE %1$I.assistant_background_queue SET claim_id=gen_random_uuid(),claim_hash=p_hash,lease_until=clock_timestamp()+interval '30 seconds'
   WHERE task_id=q.task_id RETURNING * INTO q;
  RETURN jsonb_build_object('taskId',q.task_id,'conversationId',q.conversation_id,'credential',q.credential,'claimId',q.claim_id,'expired',false);
 END $fn$;
 REVOKE ALL ON FUNCTION %1$I.take_assistant_background(uuid,text) FROM PUBLIC;
 $ddl$,current_schema());
END $migration$;
DO $migration$
DECLARE rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['assistant_tasks','assistant_channels','assistant_events'] LOOP
  EXECUTE format('CREATE POLICY schedule_background ON %I TO %I USING(true) WITH CHECK(true)',rel,current_user);
 END LOOP;
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.abandon_assistant_background(p_deployment uuid,p_task uuid,p_claim uuid,p_hash text) RETURNS boolean
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
   UPDATE %1$I.assistant_tasks SET state=next_state WHERE task_id=p_task;
   UPDATE %1$I.assistant_channels SET sequence=sequence+1 WHERE conversation_id=q.conversation_id RETURNING sequence INTO seq;
   INSERT INTO %1$I.assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,task_id,audience,type,payload)
    VALUES(gen_random_uuid(),q.deployment_id,q.owner_id,q.conversation_id,seq,p_task,t.sender,'task',jsonb_build_object('taskId',p_task,'state',next_state));
  END IF;
  IF t.parent_task_id IS NOT NULL THEN
   SELECT * INTO parent FROM %1$I.assistant_tasks WHERE task_id=t.parent_task_id AND deployment_id=q.deployment_id AND owner_id=q.owner_id AND conversation_id=q.conversation_id FOR UPDATE;
   IF parent.state='waiting_peer' AND jsonb_array_length(parent.child_task_ids)>0
    AND jsonb_array_length(parent.child_task_ids)=(SELECT count(*) FROM %1$I.assistant_tasks WHERE task_id IN (SELECT value::uuid FROM jsonb_array_elements_text(parent.child_task_ids)) AND deployment_id=q.deployment_id AND owner_id=q.owner_id AND conversation_id=q.conversation_id AND state IN ('succeeded','failed','cancelled')) THEN
    UPDATE %1$I.assistant_tasks SET state='queued' WHERE task_id=parent.task_id;
    UPDATE %1$I.assistant_channels SET sequence=sequence+1 WHERE conversation_id=q.conversation_id RETURNING sequence INTO seq;
    INSERT INTO %1$I.assistant_events(event_id,deployment_id,owner_id,conversation_id,sequence,task_id,audience,type,payload)
     VALUES(gen_random_uuid(),q.deployment_id,q.owner_id,q.conversation_id,seq,parent.task_id,parent.recipient,'task',jsonb_build_object('taskId',parent.task_id,'state','queued'));
   END IF;
  END IF;
  UPDATE %1$I.assistant_background_queue SET credential=NULL,claim_hash=NULL,lease_until=NULL WHERE task_id=p_task;
  RETURN true;
 END $fn$;
 REVOKE ALL ON FUNCTION %1$I.abandon_assistant_background(uuid,uuid,uuid,text) FROM PUBLIC;
 $ddl$,current_schema());
END $migration$;
