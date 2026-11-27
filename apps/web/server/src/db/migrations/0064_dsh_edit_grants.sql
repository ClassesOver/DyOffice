CREATE TABLE dsh_edit_grants (
 id uuid PRIMARY KEY,
 deployment_id uuid NOT NULL,
 owner_id uuid NOT NULL,
 session_id uuid NOT NULL,
 membership_id uuid NOT NULL REFERENCES assistant_members(membership_id) ON DELETE CASCADE,
 file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 created_document boolean NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 redeemed boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 FOREIGN KEY(deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id) ON DELETE CASCADE
);
CREATE INDEX dsh_edit_grants_expiry ON dsh_edit_grants(expires_at);
CREATE INDEX dsh_edit_grants_member ON dsh_edit_grants(membership_id);
REVOKE ALL ON dsh_edit_grants FROM PUBLIC;

DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
  CREATE FUNCTION %1$I.issue_dsh_edit_grant(p_id uuid,p_member uuid,p_file uuid,p_created boolean,p_hash text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
  BEGIN
   DELETE FROM %1$I.dsh_edit_grants WHERE id IN (SELECT id FROM %1$I.dsh_edit_grants WHERE expires_at<=statement_timestamp() LIMIT 100 FOR UPDATE SKIP LOCKED);
   INSERT INTO %1$I.dsh_edit_grants(id,deployment_id,owner_id,session_id,membership_id,file_id,created_document,token_hash,expires_at)
   VALUES(p_id,current_setting('dyoffice.deployment_id')::uuid,current_setting('dyoffice.user_id')::uuid,
    current_setting('dyoffice.session_id')::uuid,p_member,p_file,p_created,p_hash,clock_timestamp()+interval '1 minute');
  END
  $function$
 $ddl$,ns);

 EXECUTE format($ddl$
  CREATE FUNCTION %1$I.lock_dsh_edit_grant(p_deployment uuid,p_hash text,p_idle_ms bigint,p_replacement text)
  RETURNS TABLE(user_id uuid,session_id uuid,auth_version integer,file_id uuid,editor_id uuid,format text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
  DECLARE candidate record; issuer record; channel_id uuid; target record; member_expiration timestamptz; channel_file uuid;
  BEGIN
   IF p_replacement IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended(p_hash,0)); END IF;
   SELECT g.id,g.membership_id,s.token_hash INTO candidate FROM %1$I.dsh_edit_grants g
    JOIN %1$I.sessions s ON (s.deployment_id,s.user_id,s.id)=(g.deployment_id,g.owner_id,g.session_id)
    WHERE g.deployment_id=p_deployment AND g.token_hash=p_hash AND g.expires_at>clock_timestamp();
   IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
   SELECT * INTO issuer FROM %1$I.lock_business_session(p_deployment,candidate.token_hash,p_idle_ms);
   IF NOT FOUND OR NOT ('personal'=ANY(issuer.roles)) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
   PERFORM set_config('dyoffice.deployment_id',p_deployment::text,true);
   PERFORM set_config('dyoffice.user_id',issuer.user_id::text,true);
   PERFORM set_config('dyoffice.session_id',issuer.session_id::text,true);
   SELECT m.conversation_id INTO channel_id FROM %1$I.assistant_members m WHERE m.membership_id=candidate.membership_id;
   SELECT c.file_id INTO channel_file FROM %1$I.assistant_channels c
    WHERE c.deployment_id=p_deployment AND c.owner_id=issuer.user_id AND c.conversation_id=channel_id AND NOT c.paused FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
   SELECT m.expires_at INTO member_expiration FROM %1$I.assistant_members m
    WHERE m.deployment_id=p_deployment AND m.owner_id=issuer.user_id AND m.membership_id=candidate.membership_id
      AND m.conversation_id=channel_id AND m.kind='dsh' AND m.revoked_at IS NULL AND m.dsh_token_session_id=issuer.session_id FOR SHARE;
   IF NOT FOUND OR member_expiration<=clock_timestamp() THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
   SELECT g.* INTO target FROM %1$I.dsh_edit_grants g
    WHERE g.id=candidate.id AND g.deployment_id=p_deployment AND g.owner_id=issuer.user_id AND g.session_id=issuer.session_id
      AND g.token_hash=p_hash FOR SHARE;
   IF NOT FOUND OR target.expires_at<=clock_timestamp() OR target.redeemed<>(p_replacement IS NULL)
      OR (NOT target.created_document AND target.file_id IS DISTINCT FROM channel_file) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
   END IF;
   IF p_replacement IS NOT NULL THEN
    UPDATE %1$I.dsh_edit_grants g SET token_hash=p_replacement,redeemed=true,
     expires_at=LEAST(member_expiration,clock_timestamp()+interval '1 hour') WHERE g.id=target.id;
   END IF;
   RETURN QUERY SELECT issuer.user_id,issuer.session_id,issuer.auth_version,target.file_id,target.id,f.format::text
    FROM %1$I.files f WHERE f.deployment_id=p_deployment AND f.owner_id=issuer.user_id AND f.id=target.file_id
      AND f.deleted_at IS NULL AND f.purge_started_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
  END
  $function$
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.issue_dsh_edit_grant(uuid,uuid,uuid,boolean,text) FROM PUBLIC',ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_dsh_edit_grant(uuid,text,bigint,text) FROM PUBLIC',ns);
END $migration$;
