-- This credential table is private to the migration owner. The runtime roles
-- use the narrow functions below and never select digests or mutate grants.
CREATE TABLE mcp_read_grants (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  session_id uuid NOT NULL,
  file_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (deployment_id,owner_id,file_id,revision_id) REFERENCES file_revisions(deployment_id,owner_id,file_id,id) ON DELETE CASCADE
);
CREATE INDEX mcp_read_grants_session ON mcp_read_grants(deployment_id,owner_id,session_id);
CREATE INDEX mcp_read_grants_revision ON mcp_read_grants(deployment_id,owner_id,file_id,revision_id);
REVOKE ALL ON mcp_read_grants FROM PUBLIC;

DO $migration$
DECLARE ns text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.issue_mcp_read_grant(p_deployment uuid,p_session_hash text,p_idle_ms bigint,p_id uuid,p_hash text,p_file uuid,p_revision uuid)
    RETURNS timestamptz
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE issuer record; expiration timestamptz;
    BEGIN
      SELECT * INTO issuer FROM %1$I.lock_business_session(p_deployment,p_session_hash,p_idle_ms);
      IF NOT FOUND OR NOT ('personal'=ANY(issuer.roles)) THEN RETURN NULL; END IF;
      -- The functions for runtime sessions and row-level security use the
      -- same authenticated deployment and owner.
      PERFORM set_config('dyoffice.deployment_id',p_deployment::text,true);
      PERFORM set_config('dyoffice.user_id',issuer.user_id::text,true);
      PERFORM set_config('dyoffice.session_id',issuer.session_id::text,true);
      PERFORM 1 FROM %1$I.files f WHERE f.deployment_id=p_deployment AND f.owner_id=issuer.user_id
        AND f.id=p_file AND f.deleted_at IS NULL AND f.purge_started_at IS NULL FOR SHARE;
      IF NOT FOUND THEN RETURN NULL; END IF;
      PERFORM 1 FROM %1$I.file_revisions r WHERE r.deployment_id=p_deployment AND r.owner_id=issuer.user_id
        AND r.file_id=p_file AND r.id=p_revision AND r.reclaimed_at IS NULL;
      IF NOT FOUND THEN RETURN NULL; END IF;
      expiration := clock_timestamp() + interval '1 hour';
      INSERT INTO %1$I.mcp_read_grants(id,deployment_id,owner_id,session_id,file_id,revision_id,token_hash,expires_at)
        VALUES (p_id,p_deployment,issuer.user_id,issuer.session_id,p_file,p_revision,p_hash,expiration);
      RETURN expiration;
    END
    $function$
  $ddl$, ns);
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.revoke_mcp_read_grant(p_deployment uuid,p_session_hash text,p_idle_ms bigint,p_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE actor record;
    BEGIN
      SELECT * INTO actor FROM %1$I.lock_business_session(p_deployment,p_session_hash,p_idle_ms);
      IF NOT FOUND OR NOT ('personal'=ANY(actor.roles)) THEN RETURN false; END IF;
      UPDATE %1$I.mcp_read_grants g SET revoked_at=COALESCE(g.revoked_at,clock_timestamp())
        WHERE g.id=p_id AND g.deployment_id=p_deployment AND g.owner_id=actor.user_id;
      RETURN FOUND;
    END
    $function$
  $ddl$, ns);
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_mcp_read_grant(p_deployment uuid,p_hash text,p_idle_ms bigint)
    RETURNS TABLE(user_id uuid,session_id uuid,auth_version integer,file_id uuid,revision_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE candidate record; issuer record; locked_grant record;
    BEGIN
      SELECT g.id,s.token_hash INTO candidate FROM %1$I.mcp_read_grants g
        JOIN %1$I.sessions s ON (s.deployment_id,s.user_id,s.id)=(g.deployment_id,g.owner_id,g.session_id)
        WHERE g.deployment_id=p_deployment AND g.token_hash=p_hash;
      IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='28000'; END IF;
      -- Lock account/session before locking the grant, as in issue/revoke.
      SELECT * INTO issuer FROM %1$I.lock_business_session(p_deployment,candidate.token_hash,p_idle_ms);
      IF NOT FOUND OR NOT ('personal'=ANY(issuer.roles)) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      SELECT g.file_id,g.revision_id,g.revoked_at,g.expires_at INTO locked_grant
        FROM %1$I.mcp_read_grants g
        WHERE g.id=candidate.id AND g.deployment_id=p_deployment AND g.owner_id=issuer.user_id
          AND g.session_id=issuer.session_id AND g.token_hash=p_hash FOR SHARE;
      IF NOT FOUND OR locked_grant.revoked_at IS NOT NULL OR locked_grant.expires_at<=clock_timestamp() THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE='28000';
      END IF;
      RETURN QUERY SELECT issuer.user_id,issuer.session_id,issuer.auth_version,locked_grant.file_id,locked_grant.revision_id;
    END
    $function$
  $ddl$, ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.issue_mcp_read_grant(uuid,text,bigint,uuid,text,uuid,uuid) FROM PUBLIC', ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.revoke_mcp_read_grant(uuid,text,bigint,uuid) FROM PUBLIC', ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_mcp_read_grant(uuid,text,bigint) FROM PUBLIC', ns);
END $migration$;
