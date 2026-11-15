import { pgTable, uuid, text, boolean, integer, timestamp } from 'drizzle-orm/pg-core'
// SQL migrations own database constraints; these mappings serve typed reads.
const at = (name: string) => timestamp(name, { withTimezone: true })
export const deployments = pgTable('deployments', { id: uuid('id').primaryKey(), bootstrapCompleted: boolean('bootstrap_completed').notNull().default(false), createdAt: at('created_at').notNull().defaultNow() })
export const users = pgTable('users', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), username: text('username_normalized').notNull(),
  displayName: text('display_name').notNull(), status: text('status').notNull(), passwordHash: text('password_hash'),
  passwordChangedAt: at('password_changed_at'), authVersion: integer('auth_version').notNull(), createdAt: at('created_at').notNull(), disabledAt: at('disabled_at'),
})
export const userRoles = pgTable('user_roles', { deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), role: text('role').notNull() })
export const workspaces = pgTable('workspaces', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), ownerId: uuid('owner_id').notNull(), createdAt: at('created_at').notNull() })
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), tokenHash: text('token_hash').notNull(), authVersion: integer('auth_version').notNull(),
  createdAt: at('created_at').notNull(), lastSeenAt: at('last_seen_at').notNull(), expiresAt: at('expires_at').notNull(), revokedAt: at('revoked_at'), reauthenticatedAt: at('reauthenticated_at'),
})
export const passwordActionTokens = pgTable('password_action_tokens', {
  id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), userId: uuid('user_id').notNull(), purpose: text('purpose').notNull(), tokenHash: text('token_hash').notNull(),
  expiresAt: at('expires_at').notNull(), consumedAt: at('consumed_at'), createdAt: at('created_at').notNull(), issuedBy: uuid('issued_by').notNull(),
})
export const authAuditEvents = pgTable('auth_audit_events', { id: uuid('id').primaryKey(), deploymentId: uuid('deployment_id').notNull(), actorId: uuid('actor_id').notNull(), event: text('event').notNull(), createdAt: at('created_at').notNull() })
