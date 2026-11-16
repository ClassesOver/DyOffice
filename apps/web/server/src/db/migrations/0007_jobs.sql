CREATE TABLE native_jobs (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  session_id uuid NOT NULL,
  auth_version integer NOT NULL CHECK(auth_version>0),
  idle_ms bigint NOT NULL CHECK(idle_ms BETWEEN 1 AND 2592000000),
  file_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  type text NOT NULL CHECK(type ~ '^(docx|xlsx|pptx|pdf)\.[a-z][a-z0-9_]{0,31}$'),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
  claim_epoch bigint NOT NULL DEFAULT 0 CHECK(claim_epoch BETWEEN 0 AND 9007199254740991),
  claim_hash text CHECK(claim_hash ~ '^[0-9a-f]{64}$'),
  lease_until timestamptz,
  result_revision uuid,
  error_code text CHECK(error_code IN ('CANCELLED','AUTH_REVOKED','TIMEOUT','WORKER_FAILED','ATTEMPTS_EXHAUSTED','STALE_BASE','NATIVE_FAILED','RESOURCE_LIMIT')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE(deployment_id,owner_id,id),
  UNIQUE(deployment_id,owner_id,idempotency_key),
  FOREIGN KEY(deployment_id,owner_id,session_id) REFERENCES sessions(deployment_id,user_id,id),
  FOREIGN KEY(deployment_id,owner_id,file_id,artifact_id) REFERENCES file_revisions(deployment_id,owner_id,file_id,id),
  FOREIGN KEY(deployment_id,owner_id,file_id,result_revision) REFERENCES file_revisions(deployment_id,owner_id,file_id,id),
  CHECK(deadline_at>created_at),
  CHECK(attempts<=max_attempts),
  CHECK((state='running')=(claim_hash IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((claim_hash IS NULL)=(lease_until IS NULL)),
  CHECK((state='succeeded')=(result_revision IS NOT NULL)),
  CHECK((state IN ('succeeded','failed','cancelled'))=(finished_at IS NOT NULL))
);
CREATE INDEX native_jobs_owner ON native_jobs(deployment_id,owner_id,created_at DESC,id DESC);
CREATE INDEX native_jobs_pending ON native_jobs(deployment_id,deadline_at) WHERE state IN ('queued','running');
CREATE TABLE job_outbox (
  job_id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  delivery_epoch bigint NOT NULL DEFAULT 0 CHECK(delivery_epoch BETWEEN 0 AND 9007199254740991),
  lease_hash text CHECK(lease_hash ~ '^[0-9a-f]{64}$'),
  lease_until timestamptz,
  next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_sent_at timestamptz,
  FOREIGN KEY(deployment_id,owner_id,job_id) REFERENCES native_jobs(deployment_id,owner_id,id),
  CHECK((lease_hash IS NULL)=(lease_until IS NULL))
);
CREATE INDEX job_outbox_due ON job_outbox(deployment_id,next_delivery_at);
DO $migration$
DECLARE ns text:=current_schema(); relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['native_jobs','job_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format($policy$CREATE POLICY own_resource ON %I USING (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    ) WITH CHECK (
      deployment_id=NULLIF(pg_catalog.current_setting('dyoffice.deployment_id',true),'')::uuid
      AND owner_id=NULLIF(pg_catalog.current_setting('dyoffice.user_id',true),'')::uuid
    )$policy$,relation);
    -- Only the separate migration/function owner may scan scheduling metadata.
    -- Runtime logins are never members of this owner; no runtime BYPASSRLS.
    EXECUTE format('CREATE POLICY internal_job_service ON %I TO %I USING(true) WITH CHECK(true)',relation,current_user);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
  END LOOP;
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.lock_native_job(p_deployment uuid,p_id uuid) RETURNS %1$I.native_jobs
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs;
    BEGIN
      SELECT * INTO j FROM %1$I.native_jobs WHERE deployment_id=p_deployment AND id=p_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      PERFORM 1 FROM %1$I.users WHERE deployment_id=j.deployment_id AND id=j.owner_id FOR SHARE;
      PERFORM 1 FROM %1$I.sessions WHERE deployment_id=j.deployment_id AND user_id=j.owner_id AND id=j.session_id FOR SHARE;
      SELECT * INTO j FROM %1$I.native_jobs WHERE deployment_id=p_deployment AND id=p_id FOR UPDATE;
      RETURN j;
    END $function$;
    CREATE FUNCTION %1$I.native_job_authorized(j %1$I.native_jobs) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
      SELECT EXISTS(SELECT 1 FROM %1$I.users u JOIN %1$I.sessions s ON s.deployment_id=u.deployment_id AND s.user_id=u.id
        WHERE u.deployment_id=j.deployment_id AND u.id=j.owner_id AND s.id=j.session_id
        AND u.status='active' AND NOT u.password_reset_required AND u.auth_version=j.auth_version
        AND s.auth_version=j.auth_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND s.last_seen_at>clock_timestamp()-j.idle_ms*interval '1 millisecond'
        AND EXISTS(SELECT 1 FROM %1$I.user_roles r WHERE r.deployment_id=u.deployment_id AND r.user_id=u.id AND r.role='personal'))
    $function$;
    CREATE FUNCTION %1$I.close_native_job(p_deployment uuid,p_id uuid,p_state text,p_error text) RETURNS void
    LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $function$
      UPDATE %1$I.native_jobs SET state=p_state,error_code=p_error,finished_at=clock_timestamp(),
        claim_epoch=LEAST(claim_epoch+1,9007199254740991),claim_hash=NULL,lease_until=NULL
      WHERE deployment_id=p_deployment AND id=p_id AND state IN ('queued','running')
    $function$;
    CREATE FUNCTION %1$I.take_job_delivery(p_deployment uuid,p_hash text,p_lease_ms integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE o %1$I.job_outbox;
    BEGIN
      IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
      UPDATE %1$I.native_jobs SET state='failed',error_code='TIMEOUT',finished_at=clock_timestamp(),
        claim_hash=NULL,lease_until=NULL,claim_epoch=LEAST(claim_epoch+1,9007199254740991)
      WHERE id IN (SELECT id FROM %1$I.native_jobs WHERE deployment_id=p_deployment AND state IN ('queued','running')
        AND deadline_at<=clock_timestamp() ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED);
      SELECT x.* INTO o FROM %1$I.job_outbox x JOIN %1$I.native_jobs j ON j.id=x.job_id
        WHERE x.deployment_id=p_deployment AND x.next_delivery_at<=clock_timestamp()
        AND (x.lease_until IS NULL OR x.lease_until<=clock_timestamp())
        AND (j.state='queued' OR (j.state='running' AND j.lease_until<=clock_timestamp()))
        AND x.delivery_epoch<9007199254740991
        ORDER BY x.next_delivery_at,x.job_id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
      IF NOT FOUND THEN RETURN NULL; END IF;
      UPDATE %1$I.job_outbox SET delivery_epoch=delivery_epoch+1,lease_hash=p_hash,
        lease_until=clock_timestamp()+p_lease_ms*interval '1 millisecond' WHERE job_id=o.job_id RETURNING * INTO o;
      RETURN jsonb_build_object('jobId',o.job_id,'deliveryEpoch',o.delivery_epoch);
    END $function$;
    CREATE FUNCTION %1$I.ack_job_delivery(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_retry_ms integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    BEGIN
      IF p_retry_ms IS NULL OR p_retry_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid delivery'; END IF;
      PERFORM 1 FROM %1$I.job_outbox WHERE deployment_id=p_deployment AND job_id=p_id FOR UPDATE;
      UPDATE %1$I.job_outbox SET lease_hash=NULL,lease_until=NULL,last_sent_at=clock_timestamp(),
        next_delivery_at=clock_timestamp()+p_retry_ms*interval '1 millisecond'
      WHERE deployment_id=p_deployment AND job_id=p_id AND delivery_epoch=p_epoch AND lease_hash=p_hash AND lease_until>clock_timestamp();
      RETURN FOUND;
    END $function$;
    CREATE FUNCTION %1$I.claim_native_job(p_deployment uuid,p_id uuid,p_hash text,p_lease_ms integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs; artifact record;
    BEGIN
      IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid claim'; END IF;
      j:=%1$I.lock_native_job(p_deployment,p_id);
      IF j.id IS NULL OR j.state NOT IN ('queued','running') THEN RETURN NULL; END IF;
      IF NOT %1$I.native_job_authorized(j) THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'cancelled','AUTH_REVOKED'); RETURN NULL; END IF;
      IF j.deadline_at<=clock_timestamp() THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','TIMEOUT'); RETURN NULL; END IF;
      IF j.state='running' AND j.lease_until>clock_timestamp() THEN RETURN NULL; END IF;
      IF j.attempts>=j.max_attempts OR j.claim_epoch>=9007199254740991 THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','ATTEMPTS_EXHAUSTED'); RETURN NULL; END IF;
      PERFORM set_config('dyoffice.deployment_id',j.deployment_id::text,true),set_config('dyoffice.user_id',j.owner_id::text,true);
      SELECT r.object_key,r.sha256,r.size INTO artifact FROM %1$I.file_revisions r JOIN %1$I.files f
        ON f.deployment_id=r.deployment_id AND f.owner_id=r.owner_id AND f.id=r.file_id
        WHERE r.deployment_id=j.deployment_id AND r.owner_id=j.owner_id AND r.id=j.artifact_id AND r.file_id=j.file_id
        AND f.deleted_at IS NULL AND f.current_revision=j.artifact_id FOR SHARE OF f;
      IF NOT FOUND THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','STALE_BASE'); RETURN NULL; END IF;
      -- File locks can outlast clock deadlines even while identity locks prevent revocation.
      IF NOT %1$I.native_job_authorized(j) THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'cancelled','AUTH_REVOKED'); RETURN NULL; END IF;
      IF j.deadline_at<=clock_timestamp() THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','TIMEOUT'); RETURN NULL; END IF;
      UPDATE %1$I.native_jobs SET state='running',attempts=attempts+1,claim_epoch=claim_epoch+1,claim_hash=p_hash,
        lease_until=LEAST(deadline_at,clock_timestamp()+p_lease_ms*interval '1 millisecond'),error_code=NULL
        WHERE id=j.id RETURNING * INTO j;
      RETURN jsonb_build_object('jobId',j.id,'artifactId',j.artifact_id,'fileId',j.file_id,'baseRevision',j.artifact_id,
        'type',j.type,'epoch',j.claim_epoch,'attempt',j.attempts,'leaseUntil',j.lease_until,'deadlineAt',j.deadline_at,
        'ownerId',j.owner_id,'sessionId',j.session_id,'authVersion',j.auth_version,
        'objectKey',artifact.object_key,'sha256',artifact.sha256,'size',artifact.size);
    END $function$;
    CREATE FUNCTION %1$I.renew_native_job(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_lease_ms integer) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs;
    BEGIN
      IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 60000 THEN RAISE EXCEPTION 'Invalid renewal'; END IF;
      j:=%1$I.lock_native_job(p_deployment,p_id);
      IF j.id IS NULL OR j.state<>'running' OR j.claim_epoch<>p_epoch OR j.claim_hash<>p_hash OR p_epoch IS NULL OR p_hash IS NULL THEN RETURN NULL; END IF;
      IF NOT %1$I.native_job_authorized(j) THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'cancelled','AUTH_REVOKED'); RETURN NULL; END IF;
      IF j.deadline_at<=clock_timestamp() THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','TIMEOUT'); RETURN NULL; END IF;
      IF j.lease_until<=clock_timestamp() THEN RETURN NULL; END IF;
      UPDATE %1$I.native_jobs SET lease_until=LEAST(deadline_at,clock_timestamp()+p_lease_ms*interval '1 millisecond') WHERE id=j.id RETURNING * INTO j;
      RETURN jsonb_build_object('epoch',j.claim_epoch,'leaseUntil',j.lease_until);
    END $function$;
    CREATE FUNCTION %1$I.fail_native_job(p_deployment uuid,p_id uuid,p_epoch bigint,p_hash text,p_error text,p_retry boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE j %1$I.native_jobs;
    BEGIN
      IF p_error IS NULL OR p_error NOT IN ('WORKER_FAILED','NATIVE_FAILED','RESOURCE_LIMIT','TIMEOUT') OR p_retry IS NULL THEN RAISE EXCEPTION 'Invalid failure'; END IF;
      j:=%1$I.lock_native_job(p_deployment,p_id);
      IF j.id IS NULL OR j.state<>'running' OR j.claim_epoch<>p_epoch OR j.claim_hash<>p_hash OR p_epoch IS NULL OR p_hash IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN false; END IF;
      IF NOT %1$I.native_job_authorized(j) THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'cancelled','AUTH_REVOKED'); RETURN false; END IF;
      IF j.deadline_at<=clock_timestamp() THEN PERFORM %1$I.close_native_job(p_deployment,p_id,'failed','TIMEOUT'); RETURN false; END IF;
      IF p_retry AND j.attempts<j.max_attempts THEN
        UPDATE %1$I.native_jobs SET state='queued',error_code=p_error,claim_epoch=claim_epoch+1,claim_hash=NULL,lease_until=NULL WHERE id=j.id;
        UPDATE %1$I.job_outbox SET delivery_epoch=LEAST(delivery_epoch+1,9007199254740991),lease_hash=NULL,lease_until=NULL,next_delivery_at=clock_timestamp() WHERE job_id=j.id;
      ELSE PERFORM %1$I.close_native_job(p_deployment,p_id,'failed',p_error); END IF;
      RETURN true;
    END $function$;
  $ddl$,ns);
  FOR relation IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=ns AND p.proname IN ('lock_native_job','native_job_authorized','close_native_job','take_job_delivery','ack_job_delivery','claim_native_job','renew_native_job','fail_native_job') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',relation);
  END LOOP;
END $migration$;
