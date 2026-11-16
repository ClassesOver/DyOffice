// QA read-only projection. Caller supplies an already owner-scoped observation transaction.
export async function revisionEvidence(c, scope) {
  const revisionCounts = (
    await c.query(
      `SELECT source,count(*)::int AS count FROM file_revisions WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 GROUP BY source ORDER BY source`,
      scope,
    )
  ).rows
  const commits = (
    await c.query(
      `SELECT revision_id,upload_id,requested_source_command_id,idempotency_key,base_revision,lease_epoch FROM revision_commits WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY revision_id`,
      scope,
    )
  ).rows
  const bindings = (
    await c.query(
      `SELECT command_id,file_id,upload_id,sha256,size,idempotency_key FROM command_upload_bindings WHERE deployment_id=$1 AND owner_id=$2 AND file_id=$3 ORDER BY command_id`,
      scope,
    )
  ).rows
  const exact = (
    await c.query(
      `SELECT count(*)::int AS count
    FROM command_upload_bindings b
    JOIN command_journal j ON j.deployment_id=b.deployment_id AND j.owner_id=b.owner_id AND j.file_id=b.file_id AND j.command_id=b.command_id AND j.session_id=b.session_id
    JOIN revision_commits rc ON rc.deployment_id=b.deployment_id AND rc.owner_id=b.owner_id AND rc.file_id=b.file_id AND rc.upload_id=b.upload_id AND rc.idempotency_key=b.idempotency_key
    JOIN uploads u ON u.deployment_id=b.deployment_id AND u.owner_id=b.owner_id AND u.file_id=b.file_id AND u.id=b.upload_id
    JOIN file_revisions r ON r.deployment_id=rc.deployment_id AND r.owner_id=rc.owner_id AND r.file_id=rc.file_id AND r.id=rc.revision_id
    WHERE b.deployment_id=$1 AND b.owner_id=$2 AND b.file_id=$3 AND j.state='committed'
      AND rc.requested_source_command_id=b.command_id AND rc.job_id IS NULL
      AND rc.base_revision::text=j.record->'envelope'->>'baseRevision'
      AND rc.lease_epoch::text=j.record->'envelope'->>'leaseEpoch'
      AND u.session_id=b.session_id AND u.editor_id=b.editor_id
      AND u.base_revision=rc.base_revision AND u.lease_epoch=rc.lease_epoch
      AND u.state='committed' AND u.kind='revision' AND u.restored_from IS NULL
      AND u.sha256=b.sha256 AND u.expected_size=b.size
      AND r.source='save' AND r.parent_revision=rc.base_revision
      AND r.sha256=b.sha256 AND r.size=b.size
      AND j.record->'revision'->>'fileId'=b.file_id::text
      AND j.record->'revision'->>'revision'=r.id::text
      AND j.record->'revision'->>'sha256'=r.sha256
      AND j.record->'revision'->>'size'=r.size::text`,
      scope,
    )
  ).rows[0].count
  return {
    fileRevisionCount: revisionCounts.reduce((sum, row) => sum + row.count, 0),
    fileRevisionsBySource: revisionCounts,
    revisionCommitCount: commits.length,
    revisionCommits: commits,
    commandUploadBindingCount: bindings.length,
    commandUploadBindings: bindings,
    exactCommandReceiptJoinCount: exact,
  }
}
