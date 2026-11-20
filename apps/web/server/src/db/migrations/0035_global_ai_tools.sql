DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 EXECUTE format($ddl$
  CREATE FUNCTION %1$I.global_ai_tool_provider(p_kind text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  DECLARE dep uuid:=NULLIF(current_setting('dyoffice.deployment_id',true),'')::uuid; result jsonb;
  BEGIN
   IF p_kind IS NULL OR p_kind NOT IN ('web_search','image_search','image_generation','image_analysis','video_analysis')
     OR NOT %1$I.global_config_authorized(dep,false)
     OR NOT EXISTS(SELECT 1 FROM %1$I.user_roles WHERE deployment_id=dep AND user_id=NULLIF(current_setting('dyoffice.user_id',true),'')::uuid AND role='personal')
   THEN RAISE EXCEPTION 'AI tool provider unavailable' USING ERRCODE='42501'; END IF;
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('dyoffice:global-config:'||dep::text,0));
   SELECT jsonb_build_object('revision',g.revision,'id',e.id,'kind',e.kind,'providerId',e.provider_id,'model',e.model,'baseUrl',e.base_url,
     'envelope',s.envelope)
    INTO result
    FROM %1$I.global_configs g
    JOIN %1$I.global_config_entries e ON e.deployment_id=g.deployment_id AND e.id=g.defaults->>p_kind
    LEFT JOIN %1$I.global_config_secrets s ON s.deployment_id=e.deployment_id AND s.entry_id=e.id AND s.kind=e.kind AND s.provider_id=e.provider_id
    WHERE g.deployment_id=dep AND e.kind=p_kind AND e.enabled;
   IF NOT %1$I.global_config_authorized(dep,false) THEN RAISE EXCEPTION 'AI tool provider unavailable' USING ERRCODE='42501'; END IF;
   RETURN result;
  END $fn$
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.global_ai_tool_provider(text) FROM PUBLIC',ns);
END $migration$;
