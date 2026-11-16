DO $migration$
DECLARE ns text:=current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION %1$I.native_schema_matches(p_expected jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
    BEGIN
      IF p_expected IS NULL OR jsonb_typeof(p_expected)<>'array' THEN RETURN false; END IF;
      IF jsonb_array_length(p_expected) NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_expected) e WHERE NOT COALESCE(
        jsonb_typeof(e)='object' AND jsonb_typeof(e->'version')='number' AND (e->>'version') ~ '^[1-9][0-9]{0,5}$'
        AND jsonb_typeof(e->'sha256')='string' AND (e->>'sha256') ~ '^[0-9a-f]{64}$',false)) THEN RETURN false; END IF;
      RETURN jsonb_array_length(p_expected)=(SELECT count(*) FROM %1$I.identity_migrations)
        AND jsonb_array_length(p_expected)=(SELECT count(DISTINCT (e->>'version')::integer) FROM jsonb_array_elements(p_expected) e)
        AND NOT EXISTS(SELECT 1 FROM %1$I.identity_migrations m FULL JOIN
          (SELECT (e->>'version')::integer AS version,e->>'sha256' AS sha256 FROM jsonb_array_elements(p_expected) e) x ON x.version=m.version
          WHERE m.version IS NULL OR x.version IS NULL OR m.sha256<>x.sha256);
    END $function$;
  $ddl$,ns);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.native_schema_matches(jsonb) FROM PUBLIC',ns);
END $migration$;
