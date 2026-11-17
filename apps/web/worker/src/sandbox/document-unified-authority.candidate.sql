-- Test-only candidate, NOT in migration manifest. No production registry is populated.
CREATE TABLE document_scope_bindings (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL, owner_id uuid NOT NULL, tenant_id uuid NOT NULL,
 scope_kind text NOT NULL DEFAULT 'personal-owner' CHECK(scope_kind='personal-owner'),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL,
 UNIQUE(deployment_id,owner_id),
 FOREIGN KEY(deployment_id,owner_id) REFERENCES users(deployment_id,id)
);
CREATE TABLE document_runtime_approvals (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES deployments(id), profile_id text NOT NULL DEFAULT 'pptx-edit-v1' CHECK(profile_id='pptx-edit-v1'),
 runtime_digest text NOT NULL CHECK(runtime_digest ~ '^[0-9a-f]{64}$'),
 policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
 environment text NOT NULL DEFAULT 'test-approved' CHECK(environment='test-approved'),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL
);
CREATE TABLE document_execution_contexts (
 id uuid PRIMARY KEY, version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true,
 scope_id uuid NOT NULL REFERENCES document_scope_bindings, scope_version bigint NOT NULL,
 runtime_id uuid NOT NULL REFERENCES document_runtime_approvals, runtime_version bigint NOT NULL,
 native_facts jsonb NOT NULL, request jsonb NOT NULL,
 kind text NOT NULL DEFAULT 'immutable-native-readonly' CHECK(kind='immutable-native-readonly'),
 expires_at timestamptz NOT NULL
);
DO $candidate$
DECLARE ns text:=current_schema(); relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['document_scope_bindings','document_runtime_approvals','document_execution_contexts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY trusted_context_owner ON %I TO %I USING(true) WITH CHECK(true)',relation,current_user);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
 END LOOP;
 EXECUTE format($ddl$
 CREATE FUNCTION %1$I.document_registry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
 BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Context identities cannot be recycled'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Immutable registry identity'; END IF;
  NEW.version:=OLD.version+1;
  RETURN NEW;
 END $fn$;
 CREATE FUNCTION %1$I.document_context_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
 BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Context identities cannot be recycled'; END IF;
  IF NOT OLD.active OR NEW.active OR (to_jsonb(NEW)-'active'-'version') IS DISTINCT FROM (to_jsonb(OLD)-'active'-'version') THEN
   RAISE EXCEPTION 'Context is immutable except revocation';
  END IF;
  NEW.version:=OLD.version+1; RETURN NEW;
 END $fn$;
 CREATE TRIGGER immutable_scope BEFORE UPDATE OR DELETE ON %1$I.document_scope_bindings FOR EACH ROW EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER immutable_scope_truncate BEFORE TRUNCATE ON %1$I.document_scope_bindings FOR EACH STATEMENT EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER immutable_runtime BEFORE UPDATE OR DELETE ON %1$I.document_runtime_approvals FOR EACH ROW EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER immutable_runtime_truncate BEFORE TRUNCATE ON %1$I.document_runtime_approvals FOR EACH STATEMENT EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER immutable_context BEFORE UPDATE OR DELETE ON %1$I.document_execution_contexts FOR EACH ROW EXECUTE FUNCTION %1$I.document_context_guard();
 CREATE TRIGGER immutable_context_truncate BEFORE TRUNCATE ON %1$I.document_execution_contexts FOR EACH STATEMENT EXECUTE FUNCTION %1$I.document_context_guard();
 CREATE FUNCTION %1$I.document_issue_context(p_id uuid,p_expected jsonb,p_hash text,p_scope uuid,p_scope_version bigint,p_runtime uuid,p_runtime_version bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE native jsonb; facts jsonb; scope %1$I.document_scope_bindings; runtime %1$I.document_runtime_approvals;
         boundary timestamptz; expires timestamptz; request jsonb;
 BEGIN
  native:=%1$I.document_native_authority(p_expected,p_hash);facts:=native->'facts';
  SELECT * INTO scope FROM %1$I.document_scope_bindings WHERE id=p_scope FOR SHARE;
  SELECT * INTO runtime FROM %1$I.document_runtime_approvals WHERE id=p_runtime FOR SHARE;
  IF scope.id IS NULL OR runtime.id IS NULL OR NOT scope.active OR NOT runtime.active
    OR scope.version IS DISTINCT FROM p_scope_version OR runtime.version IS DISTINCT FROM p_runtime_version
    OR scope.deployment_id IS DISTINCT FROM (facts->>'deploymentId')::uuid OR scope.owner_id IS DISTINCT FROM (facts->>'ownerId')::uuid
    OR runtime.deployment_id IS DISTINCT FROM (facts->>'deploymentId')::uuid
    OR scope.scope_kind<>'personal-owner' OR runtime.environment<>'test-approved' OR runtime.profile_id<>'pptx-edit-v1'
    OR facts->>'jobType'<>'pptx.roundtrip' THEN RAISE EXCEPTION 'Context issuance denied' USING ERRCODE='28000'; END IF;
  native:=%1$I.document_native_authority(facts,p_hash);
  boundary:=clock_timestamp();
  expires:=LEAST((native->>'observedAt')::timestamptz+(native->>'remainingMs')::double precision*interval '1 millisecond',scope.expires_at,runtime.expires_at,boundary+interval '30 seconds');
  IF expires<=boundary THEN RAISE EXCEPTION 'Context expired' USING ERRCODE='28000'; END IF;
  request:=jsonb_build_object('protocolVersion',1,'deploymentId',facts->'deploymentId','tenantId',scope.tenant_id,'actorId',facts->'ownerId',
   'sessionBindingDigest',encode(sha256(convert_to('dyoffice:immutable-native-session:v1:'||gen_random_uuid()::text||':'||(facts->>'sessionId'),'UTF8')),'hex'),
   'fileId',facts->'fileId','editorId',facts->'editorId','leaseEpoch',facts->'leaseEpoch','baseRevision',facts->'baseRevision','generation',0,
   'jobId',facts->'jobId','attempt',facts->'attempt','jobEpoch',facts->'jobEpoch','inputSha256',facts->'inputSha256','inputSize',facts->'inputSize',
   'profileId',runtime.profile_id,'runtimeDigest',runtime.runtime_digest,'policyVersion',runtime.policy_version,
   'deadlineAt',to_char(expires AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  INSERT INTO %1$I.document_execution_contexts(id,scope_id,scope_version,runtime_id,runtime_version,native_facts,request,expires_at)
   VALUES(p_id,scope.id,scope.version,runtime.id,runtime.version,facts,request,expires);
  RETURN jsonb_build_object('context',jsonb_build_object('id',p_id,'version',1),'request',request);
 END $fn$;
 CREATE FUNCTION %1$I.document_verify_context(p_id uuid,p_version bigint,p_hash text,p_phase text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE ctx %1$I.document_execution_contexts; scope %1$I.document_scope_bindings; runtime %1$I.document_runtime_approvals;
         native jsonb; boundary timestamptz; expires timestamptz;
 BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('pre','before_start','post','return') THEN RAISE EXCEPTION 'Unknown phase' USING ERRCODE='28000'; END IF;
  -- First read chooses native identity only. Authoritative context read is locked below.
  SELECT * INTO ctx FROM %1$I.document_execution_contexts WHERE id=p_id;
  IF ctx.id IS NULL THEN RAISE EXCEPTION 'Unknown context' USING ERRCODE='28000'; END IF;
  native:=%1$I.document_native_authority(ctx.native_facts,p_hash);
  SELECT * INTO scope FROM %1$I.document_scope_bindings WHERE id=ctx.scope_id FOR SHARE;
  SELECT * INTO runtime FROM %1$I.document_runtime_approvals WHERE id=ctx.runtime_id FOR SHARE;
  SELECT * INTO ctx FROM %1$I.document_execution_contexts WHERE id=p_id FOR SHARE;
  IF NOT ctx.active OR ctx.version IS DISTINCT FROM p_version OR NOT scope.active OR NOT runtime.active
   OR scope.version<>ctx.scope_version OR runtime.version<>ctx.runtime_version
   OR ctx.kind<>'immutable-native-readonly' OR scope.scope_kind<>'personal-owner' OR runtime.environment<>'test-approved'
   OR scope.deployment_id IS DISTINCT FROM (ctx.native_facts->>'deploymentId')::uuid OR scope.owner_id IS DISTINCT FROM (ctx.native_facts->>'ownerId')::uuid
   OR runtime.deployment_id IS DISTINCT FROM (ctx.native_facts->>'deploymentId')::uuid
   OR scope.tenant_id IS DISTINCT FROM (ctx.request->>'tenantId')::uuid OR runtime.runtime_digest IS DISTINCT FROM ctx.request->>'runtimeDigest'
   OR runtime.profile_id IS DISTINCT FROM ctx.request->>'profileId' OR runtime.policy_version IS DISTINCT FROM (ctx.request->>'policyVersion')::integer
   THEN RAISE EXCEPTION 'Context changed' USING ERRCODE='28000'; END IF;
  native:=%1$I.document_native_authority(ctx.native_facts,p_hash);
  boundary:=clock_timestamp();
  expires:=LEAST(ctx.expires_at,(ctx.request->>'deadlineAt')::timestamptz,scope.expires_at,runtime.expires_at,
    (native->>'observedAt')::timestamptz+(native->>'remainingMs')::double precision*interval '1 millisecond');
  IF expires<=boundary THEN RAISE EXCEPTION 'Context expired' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('request',ctx.request,'remainingMs',floor(extract(epoch FROM expires-boundary)*1000));
 END $fn$;
 CREATE FUNCTION %1$I.document_revoke_context(p_id uuid,p_version bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 BEGIN
  UPDATE %1$I.document_execution_contexts SET active=false WHERE id=p_id AND version=p_version AND active;
  RETURN FOUND;
 END $fn$;
 $ddl$,ns);
 FOR relation IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname=ns AND p.proname IN ('document_issue_context','document_verify_context','document_revoke_context','document_registry_guard','document_context_guard') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',relation);
 END LOOP;
END $candidate$;
