import { pgTable, uuid, text, boolean, integer, timestamp, jsonb, bigint } from 'drizzle-orm/pg-core'
// SQL migrations own database constraints; these mappings serve typed reads.
const at = (name: string) => timestamp(name, { withTimezone: true })
export const deployments = pgTable('deployments', { id: uuid('id').primaryKey(), bootstrapCompleted: boolean('bootstrap_completed').notNull().default(false), createdAt: at('created_at').notNull().defaultNow() })
export const users = pgTable('users', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), username: text('username_normalized').notNull(),
  displayName: text('display_name').notNull(), status: text('status').notNull(), passwordHash: text('password_hash'), passwordResetRequired: boolean('password_reset_required').notNull().default(false),
  passwordChangedAt: at('password_changed_at'), authVersion: integer('auth_version').notNull(), createdAt: at('created_at').notNull(), disabledAt: at('disabled_at'),
})
export const userRoles = pgTable('user_roles', { deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), role: text('role').notNull() })
export const workspaces = pgTable('workspaces', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), createdAt: at('created_at').notNull() })
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), tokenHash: text('token_hash').notNull(), authVersion: integer('auth_version').notNull(),
  createdAt: at('created_at').notNull(), lastSeenAt: at('last_seen_at').notNull(), expiresAt: at('expires_at').notNull(), revokedAt: at('revoked_at'), reauthenticatedAt: at('reauthenticated_at'),
})
export const passwordActionTokens = pgTable('password_action_tokens', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), purpose: text('purpose').notNull(), authVersion: integer('auth_version').notNull(), tokenHash: text('token_hash').notNull(),
  expiresAt: at('expires_at').notNull(), consumedAt: at('consumed_at'), createdAt: at('created_at').notNull(), issuedBy: uuid('issued_by').notNull(),
})
export const authAuditEvents = pgTable('auth_audit_events', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), actorId: uuid('actor_id').notNull(), event: text('event').notNull(), createdAt: at('created_at').notNull() })

export const loginChallenges = pgTable('login_challenges', { deploymentId: uuid('deployment_id').notNull(), tokenHash: text('token_hash').primaryKey(), expiresAt: at('expires_at').notNull(), consumedAt: at('consumed_at') })
export const loginThrottles = pgTable('login_throttles', { deploymentId: uuid('deployment_id').notNull(), kind: text('kind').notNull(), keyHash: text('key_hash').notNull(), attempts: integer('attempts').notNull(), strikes: integer('strikes').notNull(), windowStartedAt: at('window_started_at').notNull(), blockedUntil: at('blocked_until') })
export const authSecurityEvents = pgTable('auth_security_events', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), actorId: uuid('actor_id'), requestId: uuid('request_id').notNull(), sessionId: uuid('session_id'), accountKey: text('account_key'), subjectUserId: uuid('subject_user_id'), event: text('event').notNull(), createdAt: at('created_at').notNull() })

export const personalPreferences = pgTable('personal_preferences', { deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), workspaceId: uuid('workspace_id').notNull(), data: jsonb('data').$type<Record<string, unknown>>().notNull(), revision: integer('revision').notNull() })

export const storageAccounts = pgTable('storage_accounts', { deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), workspaceId: uuid('workspace_id').notNull(), reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull(), storedBytes: bigint('stored_bytes', { mode: 'number' }).notNull() })
export const files = pgTable('files', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), workspaceId: uuid('workspace_id').notNull(), name: text('name').notNull(), format: text('format').notNull(), currentRevision: uuid('current_revision').notNull(), deletedAt: at('deleted_at'), purgeStartedAt: at('purge_started_at'), purgedAt: at('purged_at'), createdAt: at('created_at').notNull(), updatedAt: at('updated_at').notNull() })
export const fileRevisions = pgTable('file_revisions', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), fileId: uuid('file_id').notNull(), objectKey: text('object_key').notNull(), sha256: text('sha256').notNull(), size: integer('size').notNull(), source: text('source').notNull(), parentRevision: uuid('parent_revision'), restoredFrom: uuid('restored_from'), reclaimedAt: at('reclaimed_at'), createdAt: at('created_at').notNull() })
export const uploads = pgTable('uploads', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), workspaceId: uuid('workspace_id').notNull(), fileId: uuid('file_id').notNull(), revisionId: uuid('revision_id').notNull(), name: text('name').notNull(), format: text('format').notNull(), expectedSize: integer('expected_size').notNull(), authVersion: integer('auth_version').notNull(), state: text('state').notNull(), kind: text('kind').notNull(), baseRevision: uuid('base_revision'), leaseEpoch: bigint('lease_epoch', { mode: 'number' }), editorId: uuid('editor_id'), sessionId: uuid('session_id'), restoredFrom: uuid('restored_from'), sha256: text('sha256'), attemptId: uuid('attempt_id'), completedFileId: uuid('completed_file_id'), expiresAt: at('expires_at').notNull(), reclaimedAt: at('reclaimed_at'), createdAt: at('created_at').notNull() })

export const editLeases = pgTable('edit_leases', { deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), fileId: uuid('file_id').notNull(), sessionId: uuid('session_id').notNull(), authVersion: integer('auth_version').notNull(), editorId: uuid('editor_id').notNull(), leaseEpoch: bigint('lease_epoch', { mode: 'number' }).notNull(), expiresAt: at('expires_at').notNull() })
export const revisionCommits = pgTable('revision_commits', { deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), fileId: uuid('file_id').notNull(), idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), uploadId: uuid('upload_id').notNull(), revisionId: uuid('revision_id').notNull(), baseRevision: uuid('base_revision').notNull(), leaseEpoch: bigint('lease_epoch', { mode: 'number' }).notNull(), requestedSourceCommandId: uuid('requested_source_command_id'), createdAt: at('created_at').notNull() })
export const revisionOutbox = pgTable('revision_outbox', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), fileId: uuid('file_id').notNull(), revisionId: uuid('revision_id').notNull(), eventType: text('event_type').notNull(), payload: jsonb('payload').$type<Record<string, unknown>>().notNull(), createdAt: at('created_at').notNull(), publishedAt: at('published_at'), retiredAt: at('retired_at') })

export const nativeJobs = pgTable('native_jobs', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(),
  sessionId: uuid('session_id').notNull(), authVersion: integer('auth_version').notNull(), idleMs: bigint('idle_ms', { mode: 'number' }).notNull(),
  fileId: uuid('file_id').notNull(), artifactId: uuid('artifact_id').notNull(), type: text('type').notNull(),
  idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), state: text('state').notNull(),
  attempts: integer('attempts').notNull(), maxAttempts: integer('max_attempts').notNull(), claimEpoch: bigint('claim_epoch', { mode: 'number' }).notNull(),
  claimHash: text('claim_hash'), leaseUntil: at('lease_until'), resultRevision: uuid('result_revision'), errorCode: text('error_code'),
  createdAt: at('created_at').notNull(), deadlineAt: at('deadline_at').notNull(), finishedAt: at('finished_at'),
})
export const jobOutbox = pgTable('job_outbox', {
  jobId: uuid('job_id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(),
  deliveryEpoch: bigint('delivery_epoch', { mode: 'number' }).notNull(), leaseHash: text('lease_hash'), leaseUntil: at('lease_until'),
  nextDeliveryAt: at('next_delivery_at').notNull(), lastSentAt: at('last_sent_at'),
})
