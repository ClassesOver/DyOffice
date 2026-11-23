CREATE TABLE office_embed_settings (
 deployment_id uuid PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
 office_embed_origins jsonb NOT NULL CHECK (jsonb_typeof(office_embed_origins) = 'array' AND jsonb_array_length(office_embed_origins) <= 64)
);
ALTER TABLE office_embed_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_embed_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON office_embed_settings FROM PUBLIC;
-- Public page headers need only this non-secret deployment setting, never model configuration.
DO $migration$
DECLARE ns text:=current_schema();
BEGIN
 -- The fixed definer may read this dedicated non-secret table under FORCE RLS.
 EXECUTE format('CREATE POLICY embed_header_read ON office_embed_settings FOR SELECT TO %I USING (true)',current_user);
 EXECUTE format('CREATE POLICY embed_admin ON office_embed_settings USING (%1$I.global_config_authorized(deployment_id,true)) WITH CHECK (%1$I.global_config_authorized(deployment_id,true))',ns);
 EXECUTE format($ddl$
  CREATE FUNCTION %1$I.read_office_embed_origins(deployment uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
   SELECT office_embed_origins FROM %1$I.office_embed_settings WHERE deployment_id=deployment
  $fn$
 $ddl$,ns);
 EXECUTE format('REVOKE ALL ON FUNCTION %I.read_office_embed_origins(uuid) FROM PUBLIC',ns);
END $migration$;
