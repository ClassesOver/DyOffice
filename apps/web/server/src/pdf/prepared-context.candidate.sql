-- Test-only extension: never registered as a production migration.
-- Existing scope/registry/context guards and native/command authority are prerequisites.
CREATE TABLE pdf_runtime_candidates (
 id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES deployments(id),
 profile_id text NOT NULL DEFAULT 'pdf-edit-v1' CHECK(profile_id='pdf-edit-v1'),
 environment text NOT NULL DEFAULT 'test-approved' CHECK(environment='test-approved'),
 runtime_digest text NOT NULL CHECK(runtime_digest ~ '^[0-9a-f]{64}$'),
 version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),
 active boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL
);
CREATE TABLE pdf_prepared_contexts (
 id uuid PRIMARY KEY,version bigint NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 9007199254740991),active boolean NOT NULL DEFAULT true,
 kind text NOT NULL DEFAULT 'command-bound-non-executable' CHECK(kind='command-bound-non-executable'),
 scope_id uuid NOT NULL REFERENCES document_scope_bindings,scope_version bigint NOT NULL,
 runtime_id uuid NOT NULL REFERENCES pdf_runtime_candidates,runtime_version bigint NOT NULL,
 native_facts jsonb NOT NULL,command_json text NOT NULL,command_digest text NOT NULL,request_hash text NOT NULL,
 envelope jsonb NOT NULL,expires_at timestamptz NOT NULL
);
DO $candidate$
DECLARE ns text:=current_schema(); relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['pdf_runtime_candidates','pdf_prepared_contexts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY candidate_owner ON %I TO %I USING(true) WITH CHECK(true)',relation,current_user);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',relation);
 END LOOP;
 EXECUTE format($ddl$
 CREATE TRIGGER pdf_runtime_guard BEFORE UPDATE OR DELETE ON %1$I.pdf_runtime_candidates FOR EACH ROW EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER pdf_runtime_truncate BEFORE TRUNCATE ON %1$I.pdf_runtime_candidates FOR EACH STATEMENT EXECUTE FUNCTION %1$I.document_registry_guard();
 CREATE TRIGGER pdf_context_guard BEFORE UPDATE OR DELETE ON %1$I.pdf_prepared_contexts FOR EACH ROW EXECUTE FUNCTION %1$I.document_context_guard();
 CREATE TRIGGER pdf_context_truncate BEFORE TRUNCATE ON %1$I.pdf_prepared_contexts FOR EACH STATEMENT EXECUTE FUNCTION %1$I.document_context_guard();
 CREATE FUNCTION %1$I.pdf_prepared_authority(p_deployment uuid,p_job uuid,p_epoch bigint,p_hash text,p_expected jsonb DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE cmd jsonb; native jsonb; facts jsonb; lease %1$I.edit_leases; expires timestamptz; boundary timestamptz; request_hash text; parsed jsonb; op jsonb; page numeric; degrees numeric; seen integer[]:=ARRAY[]::integer[]; canonical text; separator text:='';
 BEGIN
  cmd:=%1$I.read_pdf_claim_command(p_deployment,p_job,p_epoch,p_hash);
  -- SQL callers must not commit an invalid command and rely on later TS parsing.
  parsed:=(cmd->>'commandJson')::jsonb;
  IF jsonb_typeof(parsed)<>'object' OR parsed-'version'-'action'-'operations'<>'{}'::jsonb OR parsed->'version'<>'1'::jsonb OR parsed->>'action'<>'rotatePages' OR jsonb_typeof(parsed->'operations')<>'array' THEN RAISE EXCEPTION 'Invalid PDF command' USING ERRCODE='28000'; END IF;
  IF jsonb_array_length(parsed->'operations') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid PDF command' USING ERRCODE='28000'; END IF;
  canonical:='{"version":1,"action":"rotatePages","operations":[';
  FOR op IN SELECT value FROM jsonb_array_elements(parsed->'operations') LOOP
   IF jsonb_typeof(op)<>'object' OR op-'page'-'degrees'<>'{}'::jsonb OR jsonb_typeof(op->'page') IS DISTINCT FROM 'number' OR jsonb_typeof(op->'degrees') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid PDF operation' USING ERRCODE='28000'; END IF;
   page:=(op->>'page')::numeric;degrees:=(op->>'degrees')::numeric;
   IF page<>trunc(page) OR page NOT BETWEEN 1 AND 100 OR degrees<>trunc(degrees) OR abs(degrees)>9007199254740991 OR mod(degrees,90)<>0 OR page::integer=ANY(seen) THEN RAISE EXCEPTION 'Invalid PDF operation' USING ERRCODE='28000'; END IF;
   seen:=array_append(seen,page::integer);canonical:=canonical||separator||'{"page":'||page::bigint::text||',"degrees":'||degrees::bigint::text||'}';separator:=',';
  END LOOP;
  canonical:=canonical||']}';
  IF canonical IS DISTINCT FROM cmd->>'commandJson' THEN RAISE EXCEPTION 'Noncanonical PDF command' USING ERRCODE='28000'; END IF;

  IF p_expected IS NULL THEN
   SELECT * INTO lease FROM %1$I.edit_leases WHERE deployment_id=p_deployment AND owner_id=(cmd->'facts'->>'ownerId')::uuid AND file_id=(cmd->'facts'->>'fileId')::uuid FOR SHARE;
   IF lease.file_id IS NULL THEN RAISE EXCEPTION 'Missing lease' USING ERRCODE='28000'; END IF;
   facts:=(cmd->'facts')||jsonb_build_object('editorId',p_job,'leaseEpoch',lease.lease_epoch,'jobType','pdf.rotate');
  ELSE facts:=p_expected; END IF;
  native:=%1$I.document_native_authority(facts,p_hash);
  IF (native->'facts') IS DISTINCT FROM facts OR (facts-'editorId'-'leaseEpoch'-'jobType') IS DISTINCT FROM cmd->'facts'
   OR facts->>'jobType'<>'pdf.rotate' THEN RAISE EXCEPTION 'PDF binding changed' USING ERRCODE='28000'; END IF;
  request_hash:=encode(sha256(convert_to('{"type":"pdf.rotate","artifactId":"'||(facts->>'baseRevision')||'","commandDigest":"'||(cmd->>'digest')||'"}','UTF8')),'hex');
  boundary:=clock_timestamp();expires:=LEAST((cmd->>'observedAt')::timestamptz+(cmd->>'remainingMs')::double precision*interval '1 millisecond',(native->>'observedAt')::timestamptz+(native->>'remainingMs')::double precision*interval '1 millisecond');
  IF expires<=boundary THEN RAISE EXCEPTION 'PDF authority expired' USING ERRCODE='28000'; END IF;
  RETURN jsonb_build_object('facts',facts,'commandJson',cmd->'commandJson','digest',cmd->'digest','requestHash',request_hash,'expiresAt',expires);
 END $fn$;
 CREATE FUNCTION %1$I.pdf_issue_prepared_context(p_id uuid,p_deployment uuid,p_job uuid,p_epoch bigint,p_hash text,p_scope uuid,p_scope_version bigint,p_runtime uuid,p_runtime_version bigint) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE proof jsonb; confirmed jsonb; scope %1$I.document_scope_bindings; runtime %1$I.pdf_runtime_candidates; expires timestamptz; envelope jsonb;
 BEGIN
  proof:=%1$I.pdf_prepared_authority(p_deployment,p_job,p_epoch,p_hash);
  SELECT * INTO scope FROM %1$I.document_scope_bindings WHERE id=p_scope FOR SHARE;
  SELECT * INTO runtime FROM %1$I.pdf_runtime_candidates WHERE id=p_runtime FOR SHARE;
  IF scope.id IS NULL OR runtime.id IS NULL OR NOT scope.active OR NOT runtime.active OR scope.version IS DISTINCT FROM p_scope_version OR runtime.version IS DISTINCT FROM p_runtime_version
   OR scope.deployment_id IS DISTINCT FROM p_deployment OR scope.owner_id IS DISTINCT FROM (proof->'facts'->>'ownerId')::uuid OR scope.scope_kind<>'personal-owner'
   OR runtime.deployment_id IS DISTINCT FROM p_deployment OR runtime.profile_id<>'pdf-edit-v1' OR runtime.environment<>'test-approved'
   THEN RAISE EXCEPTION 'PDF registry denied' USING ERRCODE='28000'; END IF;
  confirmed:=%1$I.pdf_prepared_authority(p_deployment,p_job,p_epoch,p_hash,proof->'facts');
  IF (proof-'expiresAt') IS DISTINCT FROM (confirmed-'expiresAt') THEN RAISE EXCEPTION 'PDF binding changed' USING ERRCODE='28000'; END IF;
  expires:=LEAST((proof->>'expiresAt')::timestamptz,(confirmed->>'expiresAt')::timestamptz,scope.expires_at,runtime.expires_at,clock_timestamp()+interval '30 seconds');
  envelope:=jsonb_build_object('kind','command-bound-non-executable','facts',proof->'facts','commandJson',proof->'commandJson','commandDigest',proof->'digest','requestHash',proof->'requestHash',
   'tenantId',scope.tenant_id,'runtimeDigest',runtime.runtime_digest,'runtimeEnvironment',runtime.environment,'scopeId',scope.id,'scopeVersion',scope.version,'runtimeId',runtime.id,'runtimeVersion',runtime.version);
  INSERT INTO %1$I.pdf_prepared_contexts(id,scope_id,scope_version,runtime_id,runtime_version,native_facts,command_json,command_digest,request_hash,envelope,expires_at)
   VALUES(p_id,scope.id,scope.version,runtime.id,runtime.version,proof->'facts',proof->>'commandJson',proof->>'digest',proof->>'requestHash',envelope,expires);
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'PDF context expired' USING ERRCODE='28000'; END IF;
  RETURN envelope||jsonb_build_object('context',jsonb_build_object('id',p_id,'version',1),'remainingMs',floor(extract(epoch FROM expires-clock_timestamp())*1000));
 END $fn$;
 CREATE FUNCTION %1$I.pdf_verify_prepared_context(p_id uuid,p_version bigint,p_hash text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 DECLARE initial %1$I.pdf_prepared_contexts; ctx %1$I.pdf_prepared_contexts; scope %1$I.document_scope_bindings; runtime %1$I.pdf_runtime_candidates; proof jsonb; expires timestamptz;
 BEGIN
  SELECT * INTO initial FROM %1$I.pdf_prepared_contexts WHERE id=p_id;
  IF initial.id IS NULL THEN RAISE EXCEPTION 'Unknown PDF context' USING ERRCODE='28000'; END IF;
  proof:=%1$I.pdf_prepared_authority((initial.native_facts->>'deploymentId')::uuid,(initial.native_facts->>'jobId')::uuid,(initial.native_facts->>'jobEpoch')::bigint,p_hash,initial.native_facts);
  SELECT * INTO scope FROM %1$I.document_scope_bindings WHERE id=initial.scope_id FOR SHARE;
  SELECT * INTO runtime FROM %1$I.pdf_runtime_candidates WHERE id=initial.runtime_id FOR SHARE;
  SELECT * INTO ctx FROM %1$I.pdf_prepared_contexts WHERE id=p_id FOR SHARE;
  IF ctx.id IS NULL OR NOT ctx.active OR ctx.version IS DISTINCT FROM p_version OR (to_jsonb(ctx)-'active'-'version') IS DISTINCT FROM (to_jsonb(initial)-'active'-'version')
   OR NOT scope.active OR NOT runtime.active OR scope.version IS DISTINCT FROM ctx.scope_version OR runtime.version IS DISTINCT FROM ctx.runtime_version
   OR ctx.kind<>'command-bound-non-executable' OR scope.scope_kind<>'personal-owner' OR runtime.environment<>'test-approved' OR runtime.profile_id<>'pdf-edit-v1'
   OR scope.deployment_id IS DISTINCT FROM (ctx.native_facts->>'deploymentId')::uuid OR scope.owner_id IS DISTINCT FROM (ctx.native_facts->>'ownerId')::uuid OR runtime.deployment_id IS DISTINCT FROM scope.deployment_id
   OR (ctx.envelope->>'tenantId')::uuid IS DISTINCT FROM scope.tenant_id OR ctx.envelope->>'runtimeDigest' IS DISTINCT FROM runtime.runtime_digest
   THEN RAISE EXCEPTION 'PDF context changed' USING ERRCODE='28000'; END IF;
  proof:=%1$I.pdf_prepared_authority((ctx.native_facts->>'deploymentId')::uuid,(ctx.native_facts->>'jobId')::uuid,(ctx.native_facts->>'jobEpoch')::bigint,p_hash,ctx.native_facts);
  IF proof->'facts' IS DISTINCT FROM ctx.native_facts OR proof->>'commandJson' IS DISTINCT FROM ctx.command_json OR proof->>'digest' IS DISTINCT FROM ctx.command_digest OR proof->>'requestHash' IS DISTINCT FROM ctx.request_hash
   THEN RAISE EXCEPTION 'PDF command changed' USING ERRCODE='28000'; END IF;
  expires:=LEAST(ctx.expires_at,scope.expires_at,runtime.expires_at,(proof->>'expiresAt')::timestamptz);
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'PDF context expired' USING ERRCODE='28000'; END IF;
  RETURN ctx.envelope||jsonb_build_object('context',jsonb_build_object('id',ctx.id,'version',ctx.version),'remainingMs',floor(extract(epoch FROM expires-clock_timestamp())*1000));
 END $fn$;
 CREATE FUNCTION %1$I.pdf_revoke_prepared_context(p_id uuid,p_version bigint) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 BEGIN
  UPDATE %1$I.pdf_prepared_contexts SET active=false WHERE id=p_id AND version=p_version AND active; RETURN FOUND;
 END $fn$;
 $ddl$,ns);
 FOR relation IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ns AND p.proname IN ('pdf_prepared_authority','pdf_issue_prepared_context','pdf_verify_prepared_context','pdf_revoke_prepared_context') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',relation);
 END LOOP;
END $candidate$;
