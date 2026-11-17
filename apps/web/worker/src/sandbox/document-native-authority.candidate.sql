-- Unregistered candidate. Requires current native schema (migrations 0001-0022).
-- Install only under a separate non-superuser/no-BYPASSRLS migration owner.
DO $candidate$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.document_native_authority(p_expected jsonb,p_claim_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE j %1$I.native_jobs; f %1$I.files; r %1$I.file_revisions;
         l %1$I.edit_leases; s %1$I.sessions; facts jsonb; boundary timestamptz; until_at timestamptz;
 BEGIN
  -- Reuse existing PG principal authorization, never trust fields in a JobClaim object.
  PERFORM %1$I.lock_job_principal((p_expected->>'deploymentId')::uuid,(p_expected->>'jobId')::uuid,
    (p_expected->>'jobEpoch')::bigint,p_claim_hash,false);
  SELECT * INTO j FROM %1$I.native_jobs WHERE deployment_id=(p_expected->>'deploymentId')::uuid AND id=(p_expected->>'jobId')::uuid;
  IF j.state<>'running' THEN RAISE EXCEPTION 'Native authority denied' USING ERRCODE='28000'; END IF;
  -- Match existing file -> edit lease lock order. Role lock also prevents deletion races.
  PERFORM 1 FROM %1$I.user_roles WHERE deployment_id=j.deployment_id AND user_id=j.owner_id AND role='personal' FOR SHARE;
  SELECT * INTO f FROM %1$I.files WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND id=j.file_id FOR SHARE;
  SELECT * INTO l FROM %1$I.edit_leases WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND file_id=j.file_id FOR SHARE;
  SELECT * INTO r FROM %1$I.file_revisions WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND file_id=j.file_id AND id=j.artifact_id FOR SHARE;
  SELECT * INTO s FROM %1$I.sessions WHERE deployment_id=j.deployment_id AND user_id=j.owner_id AND id=j.session_id;
  -- Final recheck is still running-only, not the completed-receipt exception.
  PERFORM %1$I.lock_job_principal(j.deployment_id,j.id,j.claim_epoch,p_claim_hash,false);
  boundary:=clock_timestamp();
  IF f.id IS NULL OR f.deleted_at IS NOT NULL OR f.purge_started_at IS NOT NULL OR f.purged_at IS NOT NULL
    OR f.current_revision IS DISTINCT FROM j.artifact_id OR f.format<>split_part(j.type,'.',1)
    OR r.id IS NULL OR r.reclaimed_at IS NOT NULL
    OR l.file_id IS NULL OR l.session_id<>j.session_id OR l.auth_version<>j.auth_version
    OR l.editor_id<>j.id OR l.job_id IS DISTINCT FROM j.id OR l.job_epoch IS DISTINCT FROM j.claim_epoch
    OR l.expires_at<=boundary THEN RAISE EXCEPTION 'Native authority denied' USING ERRCODE='28000'; END IF;
  facts:=jsonb_build_object('deploymentId',j.deployment_id,'ownerId',j.owner_id,'sessionId',j.session_id,
    'authVersion',j.auth_version,'fileId',j.file_id,'baseRevision',j.artifact_id,'jobId',j.id,'jobEpoch',j.claim_epoch,
    'attempt',j.attempts,'editorId',l.editor_id,'leaseEpoch',l.lease_epoch,'inputSha256',r.sha256,'inputSize',r.size,'jobType',j.type);
  IF p_expected IS DISTINCT FROM facts THEN RAISE EXCEPTION 'Native authority denied' USING ERRCODE='28000'; END IF;
  until_at:=LEAST(j.lease_until,j.deadline_at,l.expires_at,s.expires_at,s.last_seen_at+j.idle_ms*interval '1 millisecond');
  IF until_at<=boundary THEN RAISE EXCEPTION 'Native authority denied' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('facts',facts,'observedAt',boundary,'remainingMs',floor(extract(epoch FROM until_at-boundary)*1000));
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.document_native_authority(jsonb,text) FROM PUBLIC',ns);
END $candidate$;
