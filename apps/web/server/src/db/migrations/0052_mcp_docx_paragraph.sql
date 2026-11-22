ALTER TABLE mcp_read_grants DROP CONSTRAINT mcp_edit_approval_shape;
ALTER TABLE mcp_read_grants ADD CONSTRAINT mcp_edit_approval_shape CHECK (
  approved_edit IS NULL OR (
    jsonb_typeof(approved_edit)='object' AND octet_length(approved_edit::text)<=24576 AND
    CASE approved_edit->>'kind'
      WHEN 'pdf.rotate' THEN jsonb_typeof(approved_edit->'pages')='array'
        AND jsonb_typeof(approved_edit->'degrees')='number'
      WHEN 'xlsx.cells' THEN jsonb_typeof(approved_edit->'cells')='array'
      WHEN 'pptx.notes' THEN jsonb_typeof(approved_edit->'slide')='number'
        AND jsonb_typeof(approved_edit->'text')='string'
      WHEN 'docx.paragraph' THEN jsonb_typeof(approved_edit->'docxIndex')='number'
        AND jsonb_typeof(approved_edit->'expectedText')='string'
        AND jsonb_typeof(approved_edit->'replacement')='string'
      ELSE false
    END
  ) IS TRUE
);

DO $migration$
DECLARE ns text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.issue_mcp_edit_grant(p_deployment uuid,p_session_hash text,p_idle_ms bigint,p_id uuid,p_hash text,p_file uuid,p_revision uuid,p_edit jsonb)
    RETURNS timestamptz
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE expiration timestamptz; expected_format text;
    BEGIN
      expected_format := CASE p_edit->>'kind' WHEN 'pdf.rotate' THEN 'pdf' WHEN 'xlsx.cells' THEN 'xlsx' WHEN 'pptx.notes' THEN 'pptx' WHEN 'docx.paragraph' THEN 'docx' END;
      IF expected_format IS NULL THEN RAISE EXCEPTION 'Edit approval unavailable' USING ERRCODE='22023'; END IF;
      expiration := %1$I.issue_mcp_read_grant(p_deployment,p_session_hash,p_idle_ms,p_id,p_hash,p_file,p_revision);
      IF expiration IS NULL THEN RETURN NULL; END IF;
      PERFORM 1 FROM %1$I.files f JOIN %1$I.mcp_read_grants g
        ON (g.deployment_id,g.owner_id,g.file_id)=(f.deployment_id,f.owner_id,f.id)
        WHERE g.id=p_id AND f.format=expected_format AND f.current_revision=p_revision;
      IF NOT FOUND THEN RAISE EXCEPTION 'Edit approval unavailable' USING ERRCODE='22023'; END IF;
      UPDATE %1$I.mcp_read_grants SET approved_edit=p_edit WHERE id=p_id;
      RETURN expiration;
    END
    $function$
  $ddl$, ns);
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.record_mcp_edit(p_deployment uuid,p_hash text,p_idle_ms bigint,p_upload uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
    DECLARE authority record; saved_revision uuid;
    BEGIN
      SELECT * INTO authority FROM %1$I.lock_mcp_file_grant(p_deployment,p_hash,p_idle_ms,'publish');
      IF NOT FOUND OR authority.approved_edit IS NULL THEN
        RAISE EXCEPTION 'Edit approval unavailable' USING ERRCODE='28000';
      END IF;
      PERFORM set_config('dyoffice.deployment_id',p_deployment::text,true);
      PERFORM set_config('dyoffice.user_id',authority.user_id::text,true);
      PERFORM set_config('dyoffice.session_id',authority.session_id::text,true);
      SELECT c.revision_id INTO saved_revision FROM %1$I.revision_commits c
        JOIN %1$I.uploads u ON (u.deployment_id,u.owner_id,u.file_id,u.id)=(c.deployment_id,c.owner_id,c.file_id,c.upload_id)
        WHERE c.deployment_id=p_deployment AND c.owner_id=authority.user_id
          AND c.file_id=authority.file_id AND c.base_revision=authority.revision_id
          AND c.idempotency_key=(CASE authority.approved_edit->>'kind'
            WHEN 'pdf.rotate' THEN 'mcp_pdf_rotate_'
            WHEN 'xlsx.cells' THEN 'mcp_xlsx_cells_'
            WHEN 'pptx.notes' THEN 'mcp_pptx_notes_'
            WHEN 'docx.paragraph' THEN 'mcp_docx_paragraph_' END)||authority.grant_id::text
          AND c.upload_id=p_upload AND u.session_id=authority.session_id AND u.state='committed'
          AND c.xmin=pg_current_xact_id()::xid;
      IF NOT FOUND THEN RETURN false; END IF;
      UPDATE %1$I.mcp_read_grants g SET committed_edit_revision=saved_revision
        WHERE g.id=authority.grant_id AND g.committed_edit_revision IS NULL;
      RETURN FOUND;
    END
    $function$
  $ddl$, ns);
END $migration$;
