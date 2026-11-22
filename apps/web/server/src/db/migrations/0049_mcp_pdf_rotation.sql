ALTER TABLE mcp_read_grants ADD COLUMN approved_pdf_pages integer[];
ALTER TABLE mcp_read_grants ADD COLUMN approved_pdf_degrees integer;
ALTER TABLE mcp_read_grants ADD COLUMN committed_pdf_revision uuid;
ALTER TABLE mcp_read_grants ADD CONSTRAINT mcp_pdf_rotation_shape CHECK (
  (approved_pdf_pages IS NULL AND approved_pdf_degrees IS NULL) OR
  (approved_pdf_pages IS NOT NULL AND approved_pdf_degrees IN (-90,90,180)
    AND cardinality(approved_pdf_pages) BETWEEN 1 AND 100
    AND array_position(approved_pdf_pages,NULL) IS NULL
    AND 0 < ALL(approved_pdf_pages) AND 100 >= ALL(approved_pdf_pages))
);
ALTER TABLE mcp_read_grants ADD CONSTRAINT mcp_pdf_rotation_pair CHECK (
  (approved_pdf_pages IS NULL) = (approved_pdf_degrees IS NULL)
);

DO $migration$
DECLARE ns text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.issue_mcp_pdf_rotation_grant(p_deployment uuid,p_session_hash text,p_idle_ms bigint,p_id uuid,p_hash text,p_file uuid,p_revision uuid,p_pages integer[],p_degrees integer)
    RETURNS timestamptz
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE expiration timestamptz;
    BEGIN
      expiration := %1$I.issue_mcp_read_grant(p_deployment,p_session_hash,p_idle_ms,p_id,p_hash,p_file,p_revision);
      IF expiration IS NULL THEN RETURN NULL; END IF;
      -- The issuer has been authenticated and the owned live file is locked.
      -- Only a current, stored PDF can carry a write approval.
      PERFORM 1 FROM %1$I.files f JOIN %1$I.mcp_read_grants g
        ON (g.deployment_id,g.owner_id,g.file_id)=(f.deployment_id,f.owner_id,f.id)
        WHERE g.id=p_id AND f.format='pdf' AND f.current_revision=p_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'Edit approval unavailable' USING ERRCODE='22023'; END IF;
      UPDATE %1$I.mcp_read_grants SET approved_pdf_pages=p_pages,approved_pdf_degrees=p_degrees WHERE id=p_id;
      RETURN expiration;
    END
    $function$
  $ddl$, ns);
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_mcp_file_grant(p_deployment uuid,p_hash text,p_idle_ms bigint,p_mode text)
    RETURNS TABLE(user_id uuid,session_id uuid,auth_version integer,file_id uuid,revision_id uuid,grant_id uuid,approved_pdf_pages integer[],approved_pdf_degrees integer,committed_pdf_revision uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE candidate record; issuer record; locked_grant %1$I.mcp_read_grants%%ROWTYPE;
    BEGIN
      IF p_mode IS NULL OR p_mode NOT IN ('read','publish','cancel') THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      SELECT g.id,s.token_hash INTO candidate FROM %1$I.mcp_read_grants g
        JOIN %1$I.sessions s ON (s.deployment_id,s.user_id,s.id)=(g.deployment_id,g.owner_id,g.session_id)
        WHERE g.deployment_id=p_deployment AND g.token_hash=p_hash;
      IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
      SELECT * INTO issuer FROM %1$I.lock_business_session(p_deployment,candidate.token_hash,p_idle_ms);
      IF NOT FOUND OR NOT ('personal'=ANY(issuer.roles)) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      -- Publication takes the write lock before file/account locks. A reader
      -- cannot hold a grant SHARE lock and wait behind that file write.
      IF p_mode='publish' THEN
        SELECT g.* INTO locked_grant FROM %1$I.mcp_read_grants g WHERE g.id=candidate.id FOR NO KEY UPDATE;
      ELSIF p_mode='cancel' THEN
        -- Cancellation can only stop a request on the same authenticated
        -- legacy session. It must reach that request while it holds the row.
        SELECT g.* INTO locked_grant FROM %1$I.mcp_read_grants g WHERE g.id=candidate.id;
      ELSE
        SELECT g.* INTO locked_grant FROM %1$I.mcp_read_grants g WHERE g.id=candidate.id FOR SHARE;
      END IF;
      IF NOT FOUND OR locked_grant.deployment_id<>p_deployment OR locked_grant.owner_id<>issuer.user_id
        OR locked_grant.session_id<>issuer.session_id OR locked_grant.token_hash<>p_hash
        OR locked_grant.revoked_at IS NOT NULL OR locked_grant.expires_at<=clock_timestamp()
        OR (p_mode='publish' AND locked_grant.approved_pdf_pages IS NULL) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      RETURN QUERY SELECT issuer.user_id,issuer.session_id,issuer.auth_version,locked_grant.file_id,locked_grant.revision_id,
        locked_grant.id,locked_grant.approved_pdf_pages,locked_grant.approved_pdf_degrees,locked_grant.committed_pdf_revision;
    END
    $function$
  $ddl$, ns);
  EXECUTE format('DROP FUNCTION %I.lock_mcp_read_grant(uuid,text,bigint)', ns);
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.record_mcp_pdf_rotation(p_deployment uuid,p_hash text,p_idle_ms bigint,p_upload uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE authority record; saved_revision uuid;
    BEGIN
      SELECT * INTO authority FROM %1$I.lock_mcp_file_grant(p_deployment,p_hash,p_idle_ms,'publish');
      IF NOT FOUND OR authority.approved_pdf_pages IS NULL THEN
        RAISE EXCEPTION 'Edit approval unavailable' USING ERRCODE='28000';
      END IF;
      PERFORM set_config('dyoffice.deployment_id',p_deployment::text,true);
      PERFORM set_config('dyoffice.user_id',authority.user_id::text,true);
      PERFORM set_config('dyoffice.session_id',authority.session_id::text,true);
      SELECT c.revision_id INTO saved_revision FROM %1$I.revision_commits c
        JOIN %1$I.uploads u ON (u.deployment_id,u.owner_id,u.file_id,u.id)=(c.deployment_id,c.owner_id,c.file_id,c.upload_id)
        WHERE c.deployment_id=p_deployment AND c.owner_id=authority.user_id
          AND c.file_id=authority.file_id AND c.base_revision=authority.revision_id
          AND c.idempotency_key='mcp_pdf_rotate_'||authority.grant_id::text
          AND c.upload_id=p_upload AND u.session_id=authority.session_id AND u.state='committed'
          AND c.xmin=pg_current_xact_id()::xid;
      IF NOT FOUND THEN RETURN false; END IF;
      UPDATE %1$I.mcp_read_grants g SET committed_pdf_revision=saved_revision
        WHERE g.id=authority.grant_id AND g.committed_pdf_revision IS NULL;
      RETURN FOUND;
    END
    $function$
  $ddl$, ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.issue_mcp_pdf_rotation_grant(uuid,text,bigint,uuid,text,uuid,uuid,integer[],integer) FROM PUBLIC', ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_mcp_file_grant(uuid,text,bigint,text) FROM PUBLIC', ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.record_mcp_pdf_rotation(uuid,text,bigint,uuid) FROM PUBLIC', ns);
END $migration$;
