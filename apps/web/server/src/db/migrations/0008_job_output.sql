ALTER TABLE uploads ADD COLUMN job_id uuid;
ALTER TABLE uploads ADD COLUMN job_epoch bigint CHECK(job_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE uploads ADD CHECK((job_id IS NULL AND job_epoch IS NULL) OR (job_id IS NOT NULL AND job_epoch IS NOT NULL AND kind='revision'));
ALTER TABLE uploads ADD FOREIGN KEY(deployment_id,owner_id,job_id) REFERENCES native_jobs(deployment_id,owner_id,id);
ALTER TABLE revision_commits ADD COLUMN job_id uuid;
ALTER TABLE revision_commits ADD COLUMN job_epoch bigint CHECK(job_epoch BETWEEN 1 AND 9007199254740991);
ALTER TABLE revision_commits ADD COLUMN job_claim_hash text CHECK(job_claim_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE revision_commits ADD COLUMN job_lease_until timestamptz;
ALTER TABLE revision_commits ADD COLUMN job_transaction xid8;
ALTER TABLE revision_commits ADD CHECK (
  (job_id IS NULL AND job_epoch IS NULL AND job_claim_hash IS NULL AND job_lease_until IS NULL AND job_transaction IS NULL)
  OR (job_id IS NOT NULL AND job_epoch IS NOT NULL AND job_claim_hash IS NOT NULL AND job_lease_until IS NOT NULL AND job_transaction IS NOT NULL)
);
ALTER TABLE revision_commits ADD FOREIGN KEY(deployment_id,owner_id,job_id) REFERENCES native_jobs(deployment_id,owner_id,id);
CREATE UNIQUE INDEX revision_commits_one_job ON revision_commits(deployment_id,owner_id,job_id) WHERE job_id IS NOT NULL;
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_job_principal(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_final boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs; valid boolean:=false;
    BEGIN
      IF p_epoch IS NULL OR p_epoch NOT BETWEEN 1 AND 9007199254740991 OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_final IS NULL THEN
        RAISE EXCEPTION 'Invalid job authority' USING ERRCODE='28000';
      END IF;
      j:=%1$I.lock_native_job(p_deployment,p_id);
      IF j.id IS NULL OR j.claim_epoch<>p_epoch OR j.deadline_at<=clock_timestamp() OR NOT %1$I.native_job_authorized(j) THEN
        RAISE EXCEPTION 'Invalid job authority' USING ERRCODE='28000';
      END IF;
      PERFORM set_config('dyoffice.deployment_id',j.deployment_id::text,true),set_config('dyoffice.user_id',j.owner_id::text,true),set_config('dyoffice.session_id',j.session_id::text,true);
      IF j.state='running' THEN
        valid:=j.claim_hash=p_hash AND j.lease_until>clock_timestamp();
      ELSIF j.state='succeeded' AND p_final THEN
        -- A successful capability is dead on transaction entry. Only the final
        -- recheck of the SAME transaction that sealed the receipt may pass.
        SELECT EXISTS(SELECT 1 FROM %1$I.revision_commits c WHERE c.deployment_id=j.deployment_id AND c.owner_id=j.owner_id
          AND c.file_id=j.file_id AND c.job_id=j.id AND c.revision_id=j.result_revision AND c.base_revision=j.artifact_id
          AND c.job_epoch=p_epoch AND c.job_claim_hash=p_hash AND c.job_lease_until>clock_timestamp()
          AND c.job_transaction=pg_current_xact_id()) INTO valid;
      END IF;
      IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION 'Invalid job authority' USING ERRCODE='28000'; END IF;
      RETURN jsonb_build_object('userId',j.owner_id,'sessionId',j.session_id,'authVersion',j.auth_version,
        'jobId',j.id,'epoch',j.claim_epoch,'fileId',j.file_id,'baseRevision',j.artifact_id);
    END $function$;
    CREATE FUNCTION %1$I.complete_native_job(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_revision uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs;
    BEGIN
      PERFORM %1$I.lock_job_principal(p_deployment,p_id,p_epoch,p_hash,false);
      SELECT * INTO j FROM %1$I.native_jobs WHERE deployment_id=p_deployment AND id=p_id;
      IF NOT EXISTS(SELECT 1 FROM %1$I.revision_commits c JOIN %1$I.files f
        ON f.deployment_id=c.deployment_id AND f.owner_id=c.owner_id AND f.id=c.file_id
        WHERE c.deployment_id=j.deployment_id AND c.owner_id=j.owner_id AND c.file_id=j.file_id AND c.job_id=j.id
        AND c.revision_id=p_revision AND c.base_revision=j.artifact_id AND c.job_epoch=p_epoch
        AND c.job_claim_hash=p_hash AND c.job_lease_until=j.lease_until AND c.job_transaction=pg_current_xact_id()
        AND f.current_revision=p_revision AND f.deleted_at IS NULL)
      THEN RAISE EXCEPTION 'Missing atomic job receipt' USING ERRCODE='28000'; END IF;
      UPDATE %1$I.native_jobs SET state='succeeded',result_revision=p_revision,error_code=NULL,
        finished_at=clock_timestamp(),claim_hash=NULL,lease_until=NULL WHERE id=j.id;
      PERFORM %1$I.lock_job_principal(p_deployment,p_id,p_epoch,p_hash,true);
    END $function$;
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.lock_job_principal(uuid,uuid,bigint,text,boolean) FROM PUBLIC',ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.complete_native_job(uuid,uuid,bigint,text,uuid) FROM PUBLIC',ns);
END $migration$;
