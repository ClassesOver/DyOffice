-- Keep Codex's bounded per-turn cursor and DSH's existing bigint channel cursor.
-- A channel entry references the original event, so existing deletion and
-- retention rules also remove its stream entry.
ALTER TABLE harness_task_events
  DROP CONSTRAINT harness_task_events_pkey,
  ALTER COLUMN session_id DROP NOT NULL,
  ALTER COLUMN turn_id DROP NOT NULL,
  ALTER COLUMN sequence DROP NOT NULL,
  ALTER COLUMN payload DROP NOT NULL,
  ADD COLUMN conversation_id uuid,
  ADD COLUMN channel_sequence bigint,
  ADD COLUMN channel_event_id uuid REFERENCES assistant_events(event_id) ON DELETE CASCADE,
  ADD COLUMN channel_task_id uuid,
  ADD COLUMN channel_kind text,
  ADD CONSTRAINT harness_events_turn_sequence UNIQUE (deployment_id,owner_id,session_id,turn_id,sequence),
  ADD CONSTRAINT harness_events_channel_sequence UNIQUE (deployment_id,owner_id,conversation_id,channel_sequence),
  ADD CONSTRAINT harness_events_source CHECK (
    (session_id IS NOT NULL AND turn_id IS NOT NULL AND sequence IS NOT NULL AND payload IS NOT NULL
      AND conversation_id IS NULL AND channel_sequence IS NULL AND channel_event_id IS NULL AND channel_task_id IS NULL AND channel_kind IS NULL)
    OR
    (conversation_id IS NOT NULL AND channel_sequence IS NOT NULL AND channel_sequence > 0 AND channel_event_id IS NOT NULL AND channel_kind IS NOT NULL
      AND kind='state' AND session_id IS NULL AND turn_id IS NULL AND sequence IS NULL AND payload IS NULL)
  );

-- The existing background abandonment function runs as the migration owner
-- without a session principal. Permit that owner to append channel metadata.
CREATE POLICY schedule_channel_event ON harness_task_events FOR INSERT TO CURRENT_USER
  WITH CHECK (channel_event_id IS NOT NULL);

CREATE FUNCTION mirror_assistant_channel_event() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO harness_task_events(deployment_id,owner_id,kind,conversation_id,channel_sequence,channel_event_id,channel_task_id,channel_kind)
    VALUES(NEW.deployment_id,NEW.owner_id,'state',NEW.conversation_id,NEW.sequence,NEW.event_id,NEW.task_id,NEW.type);
  RETURN NEW;
END;
$$;

-- Take the writer lock before backfilling so a concurrent legacy writer falls
-- entirely before the copy or after the trigger is active.
CREATE TRIGGER mirror_channel_event AFTER INSERT ON assistant_events
  FOR EACH ROW EXECUTE FUNCTION mirror_assistant_channel_event();
ALTER TABLE assistant_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_task_events NO FORCE ROW LEVEL SECURITY;
INSERT INTO harness_task_events(deployment_id,owner_id,kind,conversation_id,channel_sequence,channel_event_id,channel_task_id,channel_kind)
  SELECT deployment_id,owner_id,'state',conversation_id,sequence,event_id,task_id,type FROM assistant_events;
ALTER TABLE assistant_events FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_task_events FORCE ROW LEVEL SECURITY;
