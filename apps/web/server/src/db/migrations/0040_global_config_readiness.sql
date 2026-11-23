-- Expose credential presence to authenticated settings readers, never the secret.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
  CREATE FUNCTION %1$I.global_config_key_readiness()
  RETURNS TABLE(id text,has_key boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid;
  BEGIN
   IF %1$I.global_config_authorized(dep,false) IS NOT TRUE
   THEN RAISE EXCEPTION 'Global configuration unavailable' USING ERRCODE='42501'; END IF;
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
   RETURN QUERY
    SELECT e.id,EXISTS(SELECT 1 FROM %1$I.global_config_secrets s
      WHERE s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id)
    FROM %1$I.global_config_entries e WHERE e.deployment_id=dep AND e.enabled ORDER BY e.id;
   IF %1$I.global_config_authorized(dep,false) IS NOT TRUE
   THEN RAISE EXCEPTION 'Global configuration unavailable' USING ERRCODE='42501'; END IF;
  END $fn$
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.global_config_key_readiness() FROM PUBLIC',ns);
END $migration$;
