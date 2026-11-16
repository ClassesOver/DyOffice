DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.native_deployment_ready(p_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
      SELECT EXISTS(SELECT 1 FROM %1$I.deployments WHERE id=p_id AND bootstrap_completed)
    $function$;
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.native_deployment_ready(uuid) FROM PUBLIC',ns);
END $migration$;
