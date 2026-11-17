-- Test-installed only, after command-queue.candidate.sql; no runtime table grants.
DO $candidate$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.read_pdf_claim_command(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE j %1$I.native_jobs; f %1$I.files; r %1$I.file_revisions; s %1$I.sessions;
         cmd %1$I.pdf_job_commands; boundary timestamptz; until_at timestamptz; digest text;
 BEGIN
  PERFORM %1$I.lock_job_principal(p_deployment,p_id,p_epoch,p_hash,false);
  SELECT * INTO j FROM %1$I.native_jobs WHERE deployment_id=p_deployment AND id=p_id;
  IF j.type<>'pdf.rotate' THEN RAISE EXCEPTION 'PDF claim denied' USING ERRCODE='28000'; END IF;
  PERFORM 1 FROM %1$I.user_roles WHERE deployment_id=j.deployment_id AND user_id=j.owner_id AND role='personal' FOR SHARE;
  SELECT * INTO f FROM %1$I.files WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND id=j.file_id FOR SHARE;
  SELECT * INTO r FROM %1$I.file_revisions WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND file_id=j.file_id AND id=j.artifact_id FOR SHARE;
  SELECT * INTO cmd FROM %1$I.pdf_job_commands WHERE deployment_id=j.deployment_id AND owner_id=j.owner_id AND job_id=j.id FOR SHARE;
  SELECT * INTO s FROM %1$I.sessions WHERE deployment_id=j.deployment_id AND user_id=j.owner_id AND id=j.session_id;
  -- All potentially waiting row locks precede the running-only final check.
  PERFORM %1$I.lock_job_principal(j.deployment_id,j.id,p_epoch,p_hash,false);
  boundary:=clock_timestamp();
  IF f.id IS NULL OR f.deleted_at IS NOT NULL OR f.purge_started_at IS NOT NULL OR f.purged_at IS NOT NULL
     OR f.format<>'pdf' OR f.current_revision IS DISTINCT FROM j.artifact_id
     OR r.id IS NULL OR r.reclaimed_at IS NOT NULL OR cmd.job_id IS NULL THEN
    RAISE EXCEPTION 'PDF claim denied' USING ERRCODE='28000';
  END IF;
  digest:=encode(sha256(convert_to(cmd.command_json,'UTF8')),'hex');
  -- Match JS JSON.stringify key order and compact encoding exactly, not jsonb::text.
  IF digest IS DISTINCT FROM cmd.command_digest OR j.request_hash IS DISTINCT FROM
    encode(sha256(convert_to('{"type":"pdf.rotate","artifactId":"'||j.artifact_id::text||'","commandDigest":"'||digest||'"}','UTF8')),'hex') THEN
    RAISE EXCEPTION 'PDF claim denied' USING ERRCODE='28000';
  END IF;
  until_at:=LEAST(j.lease_until,j.deadline_at,s.expires_at,s.last_seen_at+j.idle_ms*interval '1 millisecond');
  IF until_at<=boundary THEN RAISE EXCEPTION 'PDF claim denied' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('commandJson',cmd.command_json,'digest',digest,'observedAt',boundary,
    'remainingMs',floor(extract(epoch FROM until_at-boundary)*1000),
    'facts',jsonb_build_object('deploymentId',j.deployment_id,'ownerId',j.owner_id,'sessionId',j.session_id,
      'authVersion',j.auth_version,'fileId',j.file_id,'baseRevision',j.artifact_id,'jobId',j.id,
      'jobEpoch',j.claim_epoch,'attempt',j.attempts,'inputSha256',r.sha256,'inputSize',r.size));
 END $fn$;
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.read_pdf_claim_command(uuid,uuid,bigint,text) FROM PUBLIC',ns);
END $candidate$;
