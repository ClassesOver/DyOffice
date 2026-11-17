-- T17 durable, single-use upgrade credentials. Owner-scoped admission is
-- serialized in the service with a transaction advisory lock. A purge must not
-- be fenced by these short-lived credentials, so file_id intentionally has no FK.
CREATE TABLE realtime_tickets (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  session_id uuid NOT NULL,
  file_id uuid NOT NULL,
  editor_id uuid,
  ticket_hash text NOT NULL CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_id, ticket_hash),
  CHECK (expires_at > created_at)
);
CREATE INDEX realtime_tickets_live ON realtime_tickets(deployment_id,owner_id,expires_at) WHERE used_at IS NULL;
CREATE INDEX realtime_tickets_cleanup ON realtime_tickets(deployment_id,owner_id,expires_at,ticket_hash);
ALTER TABLE realtime_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_tickets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON realtime_tickets FROM PUBLIC;
CREATE POLICY own_realtime_ticket ON realtime_tickets USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND session_id=NULLIF(pg_catalog.current_setting('dyoffice.session_id',true),'')::uuid
);

-- An immutable routing receipt for the existing T14 unknown_outcome claim.
-- This is not a second command state machine: ack never changes the journal.
CREATE TABLE realtime_command_deliveries (
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  file_id uuid NOT NULL,
  editor_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  connection_epoch uuid NOT NULL,
  editor_generation bigint NOT NULL CHECK (editor_generation>=0),
  lease_epoch bigint NOT NULL CHECK (lease_epoch>=1),
  base_revision uuid NOT NULL,
  delivery_id uuid NOT NULL UNIQUE,
  claim_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(deployment_id,owner_id,session_id,command_id),
  FOREIGN KEY(deployment_id,owner_id,session_id,command_id,file_id) REFERENCES command_journal(deployment_id,owner_id,session_id,command_id,file_id)
);
ALTER TABLE realtime_command_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_command_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON realtime_command_deliveries FROM PUBLIC;
CREATE POLICY own_session_realtime_delivery ON realtime_command_deliveries USING (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND session_id=NULLIF(pg_catalog.current_setting('dyoffice.session_id',true),'')::uuid
) WITH CHECK (
  deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
  AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
  AND session_id=NULLIF(pg_catalog.current_setting('dyoffice.session_id',true),'')::uuid
);
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.guard_realtime_delivery() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $function$
 DECLARE cmd %1$I.command_journal;
 BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Delivery receipt is immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO cmd FROM %1$I.command_journal WHERE deployment_id=NEW.deployment_id AND owner_id=NEW.owner_id AND session_id=NEW.session_id AND command_id=NEW.command_id AND file_id=NEW.file_id;
  IF NOT FOUND OR NOT COALESCE(cmd.state='unknown_outcome' AND cmd.record->>'operation'='apply'
    AND cmd.record->>'claimId'=NEW.claim_id::text AND cmd.record->>'digest'=NEW.digest
    AND cmd.record->'envelope'->>'baseRevision'=NEW.base_revision::text
    AND (cmd.record->'envelope'->>'editorGeneration')::bigint=NEW.editor_generation
    AND (cmd.record->'envelope'->>'leaseEpoch')::bigint=NEW.lease_epoch,false) THEN
    RAISE EXCEPTION 'Delivery must match a durable T14 apply claim' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION %1$I.guard_realtime_delivery() FROM PUBLIC;
 CREATE TRIGGER realtime_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON %1$I.realtime_command_deliveries FOR EACH ROW EXECUTE FUNCTION %1$I.guard_realtime_delivery();
 $ddl$,ns);
END $migration$;
